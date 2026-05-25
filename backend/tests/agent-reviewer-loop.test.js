import test from "node:test";
import assert from "node:assert/strict";
import { runReviewerAuthorLoop, ReviewRejection } from "../src/aiProvider/agentLoop.js";
import { register } from "../src/utils/metrics.js";

test("loop returns immediately when reviewer accepts", async () => {
  let authorCalls = 0;
  let reviewerCalls = 0;
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => { authorCalls += 1; return artifact; },
    runReviewer: async () => { reviewerCalls += 1; return { intent: "accept" }; },
  });
  assert.equal(out.outcome, "accept");
  assert.equal(authorCalls, 1);
  assert.equal(reviewerCalls, 1);
});

test("loop revises once then accepts", async () => {
  let roundSeen = [];
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ round, artifact }) => ({ ...artifact, round }),
    runReviewer: async ({ round }) => {
      roundSeen.push(round);
      if (round === 0) return { intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "weak assertion" }] } };
      return { intent: "accept" };
    },
    maxReviewRounds: 3,
  });
  assert.deepEqual(roundSeen, [0, 1]);
  assert.equal(out.outcome, "accept");
  assert.equal(out.round, 1);
});

test("loop accepts reviewer verdict schema and maps verdict=revise to request_revision", async () => {
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async ({ round }) => {
      if (round === 0) return { verdict: "revise", artifact: { issues: [{ testId: "t1", problem: "weak assertion" }] } };
      return { verdict: "accept" };
    },
    maxReviewRounds: 3,
  });
  assert.equal(out.outcome, "accept");
  assert.equal(out.round, 1);
});

test("loop drops reviewer issues that do not reference latest author tests (downgrades to accept, no burned round)", async () => {
  // Safety contract: when every issue references a testId the author
  // never produced, the loop must NOT call the author again with empty
  // feedback. Mirrors `normalizeReviewerVerdict`'s prompt-parse-boundary
  // downgrade so callers using the runner directly get the same safety
  // net as callers using the reviewer-prompt helper.
  let authorCalls = 0;
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => { authorCalls += 1; return artifact; },
    runReviewer: async ({ round }) => {
      if (round === 0) return { verdict: "revise", artifact: { issues: [{ testId: "missing", problem: "bad id" }] } };
      return { verdict: "accept" };
    },
    maxReviewRounds: 2,
  });
  assert.equal(out.outcome, "accept");
  assert.equal(out.round, 0, "accepted on round 0 (the empty-issues revise was downgraded)");
  assert.equal(authorCalls, 1, "no second author call with empty feedback");
});

test("loop terminates at max rounds", async () => {
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => ({ intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "retry" }] } }),
    maxReviewRounds: 2,
  });
  assert.equal(out.outcome, "max_rounds");
  assert.equal(out.round, 1);
});

test("loop throws ReviewRejection on reject_final", async () => {
  let authorCalls = 0;
  await assert.rejects(
    runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
      runAuthor: async ({ artifact }) => { authorCalls += 1; return artifact; },
      runReviewer: async () => ({ intent: "reject_final" }),
    }),
    (err) => err instanceof ReviewRejection && err.code === "ERR_REVIEW_REJECT_FINAL",
  );
  assert.equal(authorCalls, 1, "no additional author calls after reject_final");
});

test("loop terminates with timeout outcome when wall-clock budget is exceeded", async () => {
  // Guaranteed-trigger fixture: the budget clamp is 1000ms (anything below
  // falls back to DEFAULT_LOOP_TIMEOUT_MS — see `clampLoopTimeoutMs`), and
  // `setTimeout(_, 50)` reliably takes >0ms in real time. So a single
  // reviewer with even a trivial real-time yield will exceed the 1000ms
  // budget after a small number of completed rounds, AND — thanks to the
  // post-reviewer deadline check added in this PR — even a single slow
  // reviewer call on `maxReviewRounds: 1` would time out. We use
  // `maxReviewRounds: 5` + 300ms reviewer sleep against the minimum-clamped
  // 1000ms budget so the deadline blows somewhere around round 4 regardless
  // of scheduler jitter; the test never depends on a tuned (rounds × sleep)
  // product narrowly matching the budget.
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "retry" }] } };
    },
    maxReviewRounds: 5,
    loopTimeoutMs: 1_000,
  });
  assert.equal(out.outcome, "timeout");
  // roundsCompleted must reflect the work actually done (Bug 1 fix —
  // result contract documents this as the canonical 1-based count).
  assert.ok(out.roundsCompleted >= 1 && out.roundsCompleted <= 5, `roundsCompleted within bounds, got ${out.roundsCompleted}`);
});

test("loop returns roundsCompleted alongside outcome for every termination path", async () => {
  // Accept on round 0 → roundsCompleted: 1
  const accept0 = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => ({ intent: "accept" }),
  });
  assert.equal(accept0.outcome, "accept");
  assert.equal(accept0.round, 0);
  assert.equal(accept0.roundsCompleted, 1);

  // Accept on round 1 (after one revise) → roundsCompleted: 2
  const accept1 = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async ({ round }) => round === 0
      ? { intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "x" }] } }
      : { intent: "accept" },
  });
  assert.equal(accept1.outcome, "accept");
  assert.equal(accept1.round, 1);
  assert.equal(accept1.roundsCompleted, 2);

  // Max rounds (3) → roundsCompleted: 3
  const maxOut = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => ({ intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "x" }] } }),
    maxReviewRounds: 3,
  });
  assert.equal(maxOut.outcome, "max_rounds");
  assert.equal(maxOut.round, 2);
  assert.equal(maxOut.roundsCompleted, 3);
});

test("loop exits early when quota check fails and reports quota_exhausted", async () => {
  let authorCalls = 0;
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => { authorCalls += 1; return artifact; },
    runReviewer: async () => ({ intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "x" }] } }),
    checkQuota: async ({ round }) => ({ ok: round === 0 }),
    maxReviewRounds: 3,
  });
  assert.equal(out.outcome, "quota_exhausted");
  assert.equal(authorCalls, 1, "ships last author artifact without entering next round");
});

test("onOutcome callback fires on every terminal path (accept, max_rounds, timeout, quota_exhausted, reject_final)", async () => {
  // Symmetry contract — operators / orchestrators that hook `onOutcome`
  // expect EVERY terminal path to surface, including `reject_final`
  // (which also throws ReviewRejection — the hook fires first, then the
  // throw happens). Pre-fix the reject_final path only recorded the
  // metric and re-threw, silently bypassing the hook.
  const seen = [];
  const onOutcome = (out) => { seen.push(out.outcome); };

  // accept on round 0
  await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => ({ intent: "accept" }),
    onOutcome,
  });

  // max_rounds
  await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => ({ intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "x" }] } }),
    maxReviewRounds: 1,
    onOutcome,
  });

  // quota_exhausted
  await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => ({ intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "x" }] } }),
    checkQuota: async () => ({ ok: false }),
    onOutcome,
  });

  // timeout — 1000ms is the minimum clamp; 300ms reviewer delay × 5
  // rounds blows the budget reliably.
  await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "x" }] } };
    },
    maxReviewRounds: 5,
    loopTimeoutMs: 1_000,
    onOutcome,
  });

  // reject_final — the hook MUST fire before the throw
  await assert.rejects(
    runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
      runAuthor: async ({ artifact }) => artifact,
      runReviewer: async () => ({ intent: "reject_final" }),
      onOutcome,
    }),
    (err) => err instanceof ReviewRejection,
  );

  // Order of completion: accept, max_rounds, quota_exhausted, timeout,
  // reject_final. Sort for resilience to scheduler interleaving.
  const sorted = [...seen].sort();
  assert.deepEqual(sorted, ["accept", "max_rounds", "quota_exhausted", "reject_final", "timeout"]);
});

test("loop records termination metric with bounded outcome label", async () => {
  await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => ({ intent: "accept" }),
  });
  const metric = register.getSingleMetric("app_agent_review_rounds");
  const json = await metric.get();
  const sawAccept = json.values.some((v) => v.labels?.outcome === "accept");
  assert.equal(sawAccept, true);
});

test("loop normalises unrecognized reviewer.intent values to accept (no silent unsanitized loop)", async () => {
  // Closed-set guard: the six envelope INTENTS that aren't loop
  // vocabulary (`handoff`, `question`, `answer`, `final`, `tool_call`,
  // `tool_result`) MUST default to "accept" rather than fall through
  // and continue the loop with raw, unsanitised reviewer feedback.
  for (const badIntent of ["handoff", "question", "answer", "final", "tool_call", "tool_result"]) {
    let authorCalls = 0;
    const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
      runAuthor: async ({ artifact }) => { authorCalls += 1; return artifact; },
      runReviewer: async () => ({ intent: badIntent, artifact: { issues: [{ testId: "anything", problem: "x" }] } }),
      maxReviewRounds: 3,
    });
    assert.equal(out.outcome, "accept", `${badIntent} → accept`);
    assert.equal(authorCalls, 1, `${badIntent} terminates after one round (no continuation)`);
  }
});

// B3.8 — Golden-fixture regression: a known-bad test with a brittle CSS-
// hashed selector ships strengthened after one revision round. Pre-fix
// (no loop) the test went out as-is; with the loop the reviewer flags
// the auto-generated class and the author rewrites it to a role-based
// locator on round 1.
test("loop strengthens a brittle-selector test after one revision round (B3.8 golden fixture)", async () => {
  const brittleTest = {
    id: "t-brittle",
    name: "Submit form",
    playwrightCode: "await page.click('.css-1a2b3c4');",
  };
  let authorCalls = 0;
  const out = await runReviewerAuthorLoop({ tests: [brittleTest] }, {
    runAuthor: async ({ artifact, reviewerIssues }) => {
      authorCalls += 1;
      if (!reviewerIssues || reviewerIssues.length === 0) return artifact;
      // Round 2 — author rewrites the brittle selector in response to
      // the reviewer's high-severity issue.
      const fixed = {
        ...brittleTest,
        playwrightCode: "await page.getByRole('button', { name: 'Submit' }).click();",
      };
      return { ...artifact, tests: [fixed] };
    },
    runReviewer: async ({ round, artifact }) => {
      const code = artifact?.tests?.[0]?.playwrightCode || "";
      const hasBrittle = /\.css-[a-z0-9]+/i.test(code);
      if (hasBrittle && round === 0) {
        return {
          intent: "request_revision",
          artifact: {
            issues: [{
              testId: "t-brittle",
              problem: "Brittle auto-generated CSS class selector",
              suggestion: "Use getByRole or data-testid",
            }],
          },
        };
      }
      return { intent: "accept" };
    },
    maxReviewRounds: 3,
  });
  assert.equal(out.outcome, "accept", "test eventually accepts after revision");
  assert.equal(out.round, 1, "accepted on the second round (round index 1)");
  assert.equal(authorCalls, 2, "author called twice (initial + one revision)");
  const finalCode = out.artifact?.tests?.[0]?.playwrightCode || "";
  assert.ok(
    finalCode.includes("getByRole"),
    `final artifact uses role-based locator, got: ${finalCode}`,
  );
  assert.ok(
    !/\.css-[a-z0-9]+/i.test(finalCode),
    "brittle CSS-hash selector is gone from final artifact",
  );
});
