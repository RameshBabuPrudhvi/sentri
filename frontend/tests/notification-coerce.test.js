/**
 * @module tests/notification-coerce
 * @description Unit tests for `frontend/src/utils/notificationCoerce.js`.
 *
 * The helpers exist because the notification bell was occasionally rendering
 * the literal text `"[object Object]"` for entries whose `title` or `body`
 * was a non-string value — typically an `Error` instance or an API envelope
 * passed by a `catch (err) { addNotification({ title: err, ... }) }` callsite.
 *
 * Defence-in-depth coverage:
 *   1. `coerceText` — every input shape the helper claims to handle, plus
 *      the warn-hook contract used by the React-bundle layer to surface
 *      offending callsites in dev mode.
 *   2. `isBadStringified` — every legacy `[object …]` string that the
 *      load-time sanitizer needs to catch, plus negative cases (real text
 *      that happens to share characters must NOT be flagged).
 *
 * Usage: node frontend/tests/notification-coerce.test.js
 */

import assert from "node:assert/strict";
import { coerceText, isBadStringified } from "../src/utils/notificationCoerce.js";

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705  ${name}`);
  } catch (err) {
    console.log(`  \u274C  ${name}`);
    console.log(`      ${err.message}`);
    process.exitCode = 1;
  }
}

// ── coerceText — passthrough cases ───────────────────────────────────────────
console.log("\n\uD83E\uDDEA coerceText \u2014 passthrough");

test("returns string input unchanged", () => {
  assert.equal(coerceText("Run complete"), "Run complete");
});
test("returns empty string for null", () => {
  assert.equal(coerceText(null), "");
});
test("returns empty string for undefined", () => {
  assert.equal(coerceText(undefined), "");
});

// ── coerceText — primitive coercion ─────────────────────────────────────────
console.log("\n\uD83E\uDDEA coerceText \u2014 primitives");

test("coerces number → string", () => {
  assert.equal(coerceText(42), "42");
});
test("coerces 0 → '0' (not empty string)", () => {
  // Regression: a naive `if (!value)` would return "" for 0, hiding a
  // legitimate numeric notification payload.
  assert.equal(coerceText(0), "0");
});
test("coerces boolean → 'true' / 'false'", () => {
  assert.equal(coerceText(true), "true");
  assert.equal(coerceText(false), "false");
});

// ── coerceText — Error instances ────────────────────────────────────────────
console.log("\n\uD83E\uDDEA coerceText \u2014 Error instances");

test("extracts .message from an Error", () => {
  const err = new Error("Network unreachable");
  assert.equal(coerceText(err), "Network unreachable");
});
test("falls back to .toString() when Error has empty message", () => {
  const err = new Error("");
  // toString() form: "Error" (no message → just the class name)
  assert.equal(coerceText(err), "Error");
});
test("extracts .message from a subclass (TypeError)", () => {
  const err = new TypeError("Cannot read property 'foo'");
  assert.equal(coerceText(err), "Cannot read property 'foo'");
});

// ── coerceText — API envelope objects ───────────────────────────────────────
console.log("\n\uD83E\uDDEA coerceText \u2014 API envelopes");

test("extracts .message from { message: '...' } envelope", () => {
  assert.equal(coerceText({ message: "Test failed" }), "Test failed");
});
test("extracts .title when .message is missing", () => {
  assert.equal(coerceText({ title: "Heads up" }), "Heads up");
});
test("extracts .error when .message and .title are missing", () => {
  assert.equal(coerceText({ error: "Validation failed" }), "Validation failed");
});
test("prefers .message over .title (Error / API convention)", () => {
  // .message is the more informative field for Error-shaped and most API
  // envelopes; .title is checked next as a fallback for legacy callsites.
  assert.equal(
    coerceText({ message: "Internal error", title: "Run failed" }),
    "Internal error",
  );
});
test("ignores non-string .message (falls through to JSON.stringify)", () => {
  // Defence against a payload like { message: 42 } — the helper must not
  // treat it as the canonical string field; instead falls through to the
  // JSON fallback so the operator at least sees the structure.
  const result = coerceText({ message: 42, code: "ERR_X" });
  assert.equal(result, JSON.stringify({ message: 42, code: "ERR_X" }));
});

// ── coerceText — JSON fallback ──────────────────────────────────────────────
console.log("\n\uD83E\uDDEA coerceText \u2014 JSON fallback");

test("JSON.stringify fallback for object without message/title/error", () => {
  const obj = { type: "info", code: 42 };
  assert.equal(coerceText(obj), JSON.stringify(obj));
});
test("returns '' on JSON.stringify failure (circular reference)", () => {
  const obj = {};
  obj.self = obj;  // circular
  // The pure helper catches the TypeError from JSON.stringify and returns
  // empty string — better than rendering "[object Object]" or crashing
  // the bell.
  assert.equal(coerceText(obj), "");
});

// ── coerceText — warn hook contract ─────────────────────────────────────────
console.log("\n\uD83E\uDDEA coerceText \u2014 warn hook");

test("warn hook fires on non-string input", () => {
  let called = false;
  let fieldArg = null;
  let valueArg = null;
  coerceText(new Error("Boom"), "title", (field, value) => {
    called = true;
    fieldArg = field;
    valueArg = value;
  });
  assert.equal(called, true, "warn hook must be invoked for non-string");
  assert.equal(fieldArg, "title");
  assert.ok(valueArg instanceof Error, "warn hook must receive the original Error");
});
test("warn hook does NOT fire on string input", () => {
  let called = false;
  coerceText("plain string", "title", () => { called = true; });
  assert.equal(called, false, "warn hook must NOT fire on legitimate string input");
});
test("warn hook does NOT fire on null / undefined", () => {
  let called = false;
  coerceText(null, "title", () => { called = true; });
  coerceText(undefined, "body", () => { called = true; });
  assert.equal(called, false, "warn hook must NOT fire on null/undefined");
});
test("warn hook does NOT fire on number / boolean (legitimate primitive)", () => {
  let called = false;
  coerceText(0, "title", () => { called = true; });
  coerceText(true, "body", () => { called = true; });
  assert.equal(called, false, "warn hook must NOT fire on primitive coercions");
});
test("warn hook errors are swallowed (defence in depth)", () => {
  // The warn hook is a side channel; if it throws (broken console.warn
  // shim, test harness mock that explodes), the coercion must still
  // return a value. Without this, a broken warn hook would crash every
  // notification with a non-string title.
  const result = coerceText(new Error("Boom"), "title", () => {
    throw new Error("warn hook exploded");
  });
  assert.equal(result, "Boom");
});

// ── isBadStringified ────────────────────────────────────────────────────────
console.log("\n\uD83E\uDDEA isBadStringified");

test("flags '[object Object]' (the canonical bad case)", () => {
  assert.equal(isBadStringified("[object Object]"), true);
});
test("flags '[object Array]'", () => {
  assert.equal(isBadStringified("[object Array]"), true);
});
test("flags '[object Error]'", () => {
  assert.equal(isBadStringified("[object Error]"), true);
});
test("flags '[object Null]'", () => {
  assert.equal(isBadStringified("[object Null]"), true);
});
test("does NOT flag a real notification title", () => {
  assert.equal(isBadStringified("Run complete"), false);
});
test("does NOT flag empty string", () => {
  assert.equal(isBadStringified(""), false);
});
test("does NOT flag a string that just mentions 'object'", () => {
  assert.equal(isBadStringified("Detected 3 objects on the page"), false);
});
test("returns false for non-string inputs (defensive)", () => {
  assert.equal(isBadStringified(null), false);
  assert.equal(isBadStringified(undefined), false);
  assert.equal(isBadStringified(42), false);
  assert.equal(isBadStringified({}), false);
});

// ── Summary ──────────────────────────────────────────────────────────────────
if (process.exitCode) {
  console.log("\n\u26A0\uFE0F  Some notification-coerce tests failed");
  process.exit(1);
}
console.log("\n\uD83C\uDF89 All notification-coerce tests passed");
