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
  // The deadline check fires at the TOP of each while-iteration, BEFORE
  // `runAuthor` runs. So for `maxReviewRounds: N` and `loopTimeoutMs: B`,
  // the reviewer's per-round latency must satisfy
  //   `(N - 1) * latency > B`
  // for the check to fire on iteration N-1 instead of the loop exiting
  // naturally via `round < N`. With N=2 and B=1005ms, latency > 1005ms
  // suffices. We use 600ms per round across 2 rounds — round 0 finishes
  // at ~600ms, top-of-loop check at round 1 sees 600 < 1005 (passes),
  // round 1 finishes at ~1200ms, top-of-loop check that WOULD start
  // round 2 (but the loop already exited at `round < 2`) — so we set
  // N=3 and use 600ms so round 1's top-check is 600ms (pass), round 2's
  // top-check is 1200ms (FAIL → timeout). Pre-fix this used 15ms × 3,
  // total ~45ms vs 1005ms budget — the check never fired and the loop
  // returned `max_rounds` instead of `timeout` (devin-ai-integration
  // review thread #1).
  const out = await runReviewerAuthorLoop({ tests: [{ id: "t1" }] }, {
    runAuthor: async ({ artifact }) => artifact,
    runReviewer: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { intent: "request_revision", artifact: { issues: [{ testId: "t1", problem: "retry" }] } };
    },
    maxReviewRounds: 3,
    loopTimeoutMs: 1_005,
  });
  assert.equal(out.outcome, "timeout");
});
