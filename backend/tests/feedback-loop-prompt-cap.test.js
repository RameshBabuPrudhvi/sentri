/**
 * Bundle-A fix #8 — `buildImprovementPrompt` caps the elements-JSON
 * block at 8 KB so a verbose element snapshot can't balloon the
 * improvement prompt past the model's context window.
 *
 * The per-tier `maxElements` cap bounds the COUNT of elements but not
 * their cumulative serialised size — a single element with a verbose
 * `outerHTML` attribute can spend hundreds of bytes. The byte cap
 * applied via `capElementsJson` is defence-in-depth against that.
 *
 * Tests target the exported helper directly (it's a pure function),
 * pinning the boundary at exactly the byte threshold.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  capElementsJson,
  ELEMENTS_JSON_MAX_BYTES,
  ELEMENTS_JSON_TRUNCATION_MARKER,
} = await import("../src/pipeline/feedbackLoop.js");

test("capElementsJson passes short input through unchanged", () => {
  const small = JSON.stringify({ tag: "button", text: "Sign in" }, null, 2);
  assert.ok(small.length < ELEMENTS_JSON_MAX_BYTES, "fixture must be under cap");
  assert.equal(capElementsJson(small), small);
});

test("capElementsJson truncates oversized JSON and appends marker", () => {
  // Build a fixture much larger than the 8 KB cap. 200 elements with
  // realistic verbosity reliably overshoots.
  const elements = Array.from({ length: 200 }, (_, i) => ({
    tag: "button",
    id: `btn-${i}`,
    text: `Element label number ${i}`.repeat(5),
    selector: `#root > div > section > button:nth-child(${i})`,
    outerHTML: `<button id="btn-${i}" class="btn btn-primary">Element label number ${i}</button>`.repeat(2),
  }));
  const json = JSON.stringify(elements, null, 2);
  assert.ok(json.length > ELEMENTS_JSON_MAX_BYTES, `precondition: 200-element JSON must exceed cap, got ${json.length}`);

  const out = capElementsJson(json);
  assert.ok(
    out.length <= ELEMENTS_JSON_MAX_BYTES,
    `capped output must fit under ${ELEMENTS_JSON_MAX_BYTES} bytes, got ${out.length}`,
  );
  assert.ok(
    out.endsWith(ELEMENTS_JSON_TRUNCATION_MARKER),
    `capped output must end with truncation marker, got tail: "${out.slice(-40)}"`,
  );
});

test("capElementsJson exactly-at-cap input is NOT truncated (boundary)", () => {
  const exact = "a".repeat(ELEMENTS_JSON_MAX_BYTES);
  const out = capElementsJson(exact);
  assert.equal(out, exact, "exactly-at-cap input should pass through");
  assert.equal(out.length, ELEMENTS_JSON_MAX_BYTES);
});

test("capElementsJson one-byte-over-cap input IS truncated (boundary)", () => {
  const over = "a".repeat(ELEMENTS_JSON_MAX_BYTES + 1);
  const out = capElementsJson(over);
  assert.ok(out.length <= ELEMENTS_JSON_MAX_BYTES, "one-byte-over must be truncated");
  assert.ok(out.endsWith(ELEMENTS_JSON_TRUNCATION_MARKER), "must end with marker");
});

test("capElementsJson handles non-string input defensively", () => {
  // Non-string inputs (null, undefined, accidental objects) MUST pass
  // through unchanged so a future caller mistake doesn't crash prompt
  // construction. The cap is best-effort, not a strict contract.
  assert.equal(capElementsJson(null), null);
  assert.equal(capElementsJson(undefined), undefined);
  const obj = { not: "a string" };
  assert.equal(capElementsJson(obj), obj);
});

console.log("✅ feedback-loop-prompt-cap tests passed");
