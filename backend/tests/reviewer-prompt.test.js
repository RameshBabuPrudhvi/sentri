import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewerVerdict } from "../src/prompts/reviewerPrompt.js";

test("normalizeReviewerVerdict keeps revise only when issues reference known tests", () => {
  const out = normalizeReviewerVerdict({
    verdict: "revise",
    issues: [
      { testId: "t-1", message: "weak assert" },
      { testId: "missing", message: "bad" },
    ],
  }, new Set(["t-1"]));
  assert.equal(out.verdict, "revise");
  assert.equal(out.issues.length, 1);
  assert.equal(out.issues[0].testId, "t-1");
});

test("normalizeReviewerVerdict downgrades revise with empty valid issues to accept", () => {
  const out = normalizeReviewerVerdict({ verdict: "revise", issues: [{ testId: "x", message: "bad" }] }, new Set(["t-1"]));
  assert.equal(out.verdict, "accept");
  assert.deepEqual(out.issues, []);
});
