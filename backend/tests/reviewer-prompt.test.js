import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewerVerdict, ReviewerEnvelopeError } from "../src/prompts/reviewerPrompt.js";

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

test("normalizeReviewerVerdict (soft mode) surfaces dropped issues with reason codes", () => {
  // Roadmap contract — issues that violate the testId-must-reference-author-artifact
  // rule should not vanish silently. Soft mode (default) keeps the
  // pre-fix behaviour of returning a valid verdict but now also reports
  // what was filtered, so callers can audit / log the drops.
  const out = normalizeReviewerVerdict({
    verdict: "revise",
    issues: [
      { testId: "t-1", message: "weak assert" },           // kept
      { testId: "missing", message: "bad" },                // dropped: unknown_test_id
      { testId: "", message: "no id" },                     // dropped: missing_fields
      { testId: "t-1" },                                    // dropped: missing_fields (no problem)
    ],
  }, new Set(["t-1"]));
  assert.equal(out.verdict, "revise");
  assert.equal(out.issues.length, 1, "only the t-1 issue survives");
  assert.ok(Array.isArray(out.droppedIssues), "droppedIssues array populated");
  assert.equal(out.droppedIssues.length, 3, "three drops surfaced");
  const reasons = out.droppedIssues.map((d) => d.reason).sort();
  assert.deepEqual(reasons, ["missing_fields", "missing_fields", "unknown_test_id"]);
});

test("normalizeReviewerVerdict (strict mode) throws ReviewerEnvelopeError on unknown testIds", () => {
  // Strict mode enforces the roadmap's "envelope validation fails" contract.
  // The loop runner / orchestrator opts into this so a bad reviewer
  // envelope surfaces as a structured outcome instead of silently filtering.
  assert.throws(
    () => normalizeReviewerVerdict({
      verdict: "revise",
      issues: [
        { testId: "t-1", message: "ok" },
        { testId: "alien", message: "bad" },
      ],
    }, new Set(["t-1"]), { strict: true }),
    (err) => {
      assert.ok(err instanceof ReviewerEnvelopeError, "throws ReviewerEnvelopeError");
      assert.equal(err.code, "ERR_REVIEWER_ENVELOPE_INVALID");
      assert.equal(err.droppedIssues.length, 1, "carries every contract violation, not just the first");
      assert.equal(err.droppedIssues[0].testId, "alien");
      assert.equal(err.droppedIssues[0].reason, "unknown_test_id");
      return true;
    },
  );
});

test("normalizeReviewerVerdict (strict mode) does NOT throw on missing_fields drops alone", () => {
  // Missing-fields drops are different from unknown_test_id drops —
  // they're "LLM returned garbage" rather than "LLM violated the
  // testId-validation contract". Strict mode only enforces the
  // contract, so a malformed-but-non-violating envelope still passes.
  const out = normalizeReviewerVerdict({
    verdict: "revise",
    issues: [
      { testId: "t-1", message: "ok" },
      { testId: "", message: "no id" },
    ],
  }, new Set(["t-1"]), { strict: true });
  assert.equal(out.verdict, "revise");
  assert.equal(out.issues.length, 1);
  assert.equal(out.droppedIssues.length, 1);
  assert.equal(out.droppedIssues[0].reason, "missing_fields");
});

test("normalizeReviewerVerdict clean input returns no droppedIssues key", () => {
  // Zero-overhead path — when nothing was filtered, the return shape
  // matches the pre-PR contract byte-for-byte. Existing consumers that
  // destructure `{ verdict, issues }` aren't broken by the new field.
  const out = normalizeReviewerVerdict({
    verdict: "accept",
    issues: [{ testId: "t-1", message: "advisory" }],
  }, new Set(["t-1"]));
  assert.equal(out.verdict, "accept");
  assert.equal(out.issues.length, 1);
  assert.equal(out.droppedIssues, undefined, "no droppedIssues key on clean input");
});
