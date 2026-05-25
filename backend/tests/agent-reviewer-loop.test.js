import test from "node:test";
import assert from "node:assert/strict";
import { runReviewerAuthorLoop, ReviewRejection } from "../src/aiProvider/agentLoop.js";

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

test("loop drops reviewer issues that do not reference latest author tests", async () => {
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async ({ round }) => {
      if (round === 0) return { verdict: "revise", artifact: { issues: [{ testId: "missing", problem: "bad id" }] } };
      return { verdict: "accept" };
    },
    maxReviewRounds: 2,
  });
  assert.equal(out.outcome, "accept");
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
  await assert.rejects(
    runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
      runAuthor: async ({ artifact }) => artifact,
      runReviewer: async () => ({ intent: "reject_final" }),
    }),
    (err) => err instanceof ReviewRejection && err.code === "ERR_REVIEW_REJECT_FINAL",
  );
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
