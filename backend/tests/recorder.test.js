/**
 * @module tests/recorder
 * @description Unit tests for the interactive browser recorder (DIF-015).
 *
 * Only `actionsToPlaywrightCode` is tested here — it is a pure string
 * transformation that does not require Playwright or a browser. The
 * `startRecording` / `stopRecording` pair depends on a real Chromium
 * launch and is covered implicitly by manual end-to-end testing.
 */

import assert from "node:assert/strict";
import { actionsToPlaywrightCode } from "../src/runner/recorder.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log("\n🧪 recorder — actionsToPlaywrightCode");

test("does not duplicate the initial goto that startRecording pushes as actions[0]", () => {
  // startRecording always pushes `{ kind: "goto", url: startUrl }` as the
  // first action. actionsToPlaywrightCode already emits `page.goto(startUrl)`
  // at the top of the test body, so that first action must be suppressed to
  // avoid two back-to-back navigations to the same URL.
  const code = actionsToPlaywrightCode("Dedup", "https://example.com", [
    { kind: "goto", url: "https://example.com", ts: 1 },
    { kind: "click", selector: "#btn", ts: 2 },
  ]);
  const gotos = code.match(/await page\.goto\('https:\/\/example\.com'\);/g) || [];
  assert.equal(gotos.length, 1, "only one goto to startUrl should be emitted");
  assert.match(code, /await safeClick\(page, '#btn'\);/);
});

test("deduplicates consecutive gotos to the same URL", () => {
  const code = actionsToPlaywrightCode("Consecutive", "https://example.com", [
    { kind: "goto", url: "https://example.com", ts: 1 },
    { kind: "goto", url: "https://example.com/dashboard", ts: 2 },
    { kind: "goto", url: "https://example.com/dashboard", ts: 3 }, // framenavigated echo
    { kind: "click", selector: "#ok", ts: 4 },
  ]);
  const dashGotos = code.match(/page\.goto\('https:\/\/example\.com\/dashboard'\)/g) || [];
  assert.equal(dashGotos.length, 1, "consecutive gotos to the same URL collapse to one");
});

test("emits a runnable test skeleton even for zero actions", () => {
  const code = actionsToPlaywrightCode("Empty", "https://example.com", []);
  assert.match(code, /import \{ test, expect \} from '@playwright\/test';/);
  assert.match(code, /test\('Empty', async \(\{ page \}\) => \{/);
  assert.match(code, /await page\.goto\('https:\/\/example\.com'\);/);
  assert.match(code, /await expect\(page\)\.toHaveURL\(\/\.\*\/\);/);
});

test("translates a mixed action list into safeClick / safeFill / keyboard.press", () => {
  const code = actionsToPlaywrightCode("Login flow", "https://example.com/login", [
    { kind: "click", selector: "#submit", ts: 1 },
    { kind: "fill", selector: "#email", value: "user@example.com", ts: 2 },
    { kind: "press", key: "Enter", ts: 3 },
    { kind: "select", selector: "#country", value: "US", ts: 4 },
    { kind: "check", selector: "#agree", ts: 5 },
    { kind: "uncheck", selector: "#agree", ts: 6 },
    { kind: "goto", url: "https://example.com/dashboard", ts: 7 },
  ]);
  assert.match(code, /await safeClick\(page, '#submit'\);/);
  assert.match(code, /await safeFill\(page, '#email', 'user@example\.com'\);/);
  assert.match(code, /await page\.keyboard\.press\('Enter'\);/);
  assert.match(code, /await page\.selectOption\('#country', 'US'\);/);
  assert.match(code, /await page\.check\('#agree'\);/);
  assert.match(code, /await page\.uncheck\('#agree'\);/);
  assert.match(code, /await page\.goto\('https:\/\/example\.com\/dashboard'\);/);
});

test("skips actions with missing selectors / keys / urls", () => {
  const code = actionsToPlaywrightCode("Sparse", "https://example.com", [
    { kind: "click", ts: 1 },        // no selector → skipped
    { kind: "press", ts: 2 },        // no key → skipped
    { kind: "goto", ts: 3 },         // no url → skipped
    { kind: "click", selector: "#ok", ts: 4 },
  ]);
  const clicks = code.match(/await safeClick/g) || [];
  assert.equal(clicks.length, 1, "only the well-formed click should be emitted");
  assert.doesNotMatch(code, /await page\.keyboard\.press\('/);
});

// ── Devin Review BUG_0002 regression — URL escaping ────────────────────────

test("escapes single quotes in the starting URL", () => {
  const code = actionsToPlaywrightCode(
    "Quote in start",
    "https://example.com/it's-a-page",
    [],
  );
  assert.match(code, /await page\.goto\('https:\/\/example\.com\/it\\'s-a-page'\);/);
});

test("escapes single quotes in per-step goto URLs", () => {
  const code = actionsToPlaywrightCode("Quote in step", "https://example.com", [
    { kind: "goto", url: "https://example.com/it's-a-page", ts: 1 },
  ]);
  assert.match(code, /await page\.goto\('https:\/\/example\.com\/it\\'s-a-page'\);/);
});

test("escapes single quotes in test name, selectors, and fill values", () => {
  const code = actionsToPlaywrightCode("It's a test", "https://example.com", [
    { kind: "click", selector: "button[aria-label='Close']", ts: 1 },
    { kind: "fill", selector: "#q", value: "I'm here", ts: 2 },
  ]);
  assert.match(code, /test\('It\\'s a test'/);
  assert.match(code, /await safeClick\(page, 'button\[aria-label=\\'Close\\']'\);/);
  assert.match(code, /await safeFill\(page, '#q', 'I\\'m here'\);/);
});

test("escapes newlines in fill values so multiline <textarea> input produces valid JS", () => {
  // A user typing into a <textarea> produces a `fill` action whose value
  // contains a literal U+000A. Interpolating that raw into a single-quoted
  // literal would split the string across source lines → SyntaxError at
  // runtime. The generated code must use `\\n` escapes.
  const code = actionsToPlaywrightCode("Multiline", "https://example.com", [
    { kind: "fill", selector: "#bio", value: "line1\nline2\nline3", ts: 1 },
  ]);
  // No raw newline inside the generated fill call.
  assert.doesNotMatch(code, /safeFill\(page, '#bio', 'line1\nline2/);
  // Properly escaped sequence.
  assert.match(code, /await safeFill\(page, '#bio', 'line1\\nline2\\nline3'\);/);
});

test("escapes backslashes so Windows paths and raw escape sequences replay verbatim", () => {
  // Raw `C:\new\file` would get re-interpreted: `\n` → newline, `\f` → form
  // feed. Backslashes must be doubled up first so the replayed value is
  // identical to what the user typed.
  const code = actionsToPlaywrightCode("Paths", "https://example.com", [
    { kind: "fill", selector: "#path", value: "C:\\new\\file", ts: 1 },
  ]);
  assert.match(code, /await safeFill\(page, '#path', 'C:\\\\new\\\\file'\);/);
});

test("escapes carriage returns and U+2028 / U+2029 line separators", () => {
  const code = actionsToPlaywrightCode("Sep", "https://example.com", [
    { kind: "fill", selector: "#x", value: "a\rb\u2028c\u2029d", ts: 1 },
  ]);
  assert.match(code, /await safeFill\(page, '#x', 'a\\rb\\u2028c\\u2029d'\);/);
});

test("escapes control characters (e.g. backspace U+0008) via \\xHH", () => {
  const code = actionsToPlaywrightCode("Ctrl", "https://example.com", [
    { kind: "fill", selector: "#x", value: "a\bb", ts: 1 },
  ]);
  assert.match(code, /await safeFill\(page, '#x', 'a\\x08b'\);/);
});

test("generated code is always syntactically parseable regardless of captured value content", () => {
  // Property-check style: throw every ugly string we can think of at the
  // generator and confirm the result parses as a module. If this ever
  // regresses the project's runner will refuse to execute the recorded
  // test at runtime.
  const nasties = [
    "simple",
    "it's complex",
    "line1\nline2",
    "C:\\Users\\root",
    "mix: '\\n' and \"quotes\" and \t\ttabs",
    "\u2028\u2029",
    "null\u0000byte",
  ];
  for (const s of nasties) {
    const code = actionsToPlaywrightCode(s, "https://example.com/" + s, [
      { kind: "fill", selector: "#f", value: s, ts: 1 },
      { kind: "select", selector: "#s", value: s, ts: 2 },
      { kind: "press", key: "Enter", ts: 3 },
    ]);
    // The generator wraps the body inside `test('…', async ({ page }) => { … })`
    // and prepends an `import` line. Strip both so we can parse just the body
    // as a Function and validate that every interpolated string literal is
    // syntactically valid.
    const bodyMatch = code.match(/async \(\{ page \}\) => \{\n([\s\S]*)\n\}\);\n$/);
    assert.ok(bodyMatch, `generated code should have the expected wrapper shape for input ${JSON.stringify(s)}`);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    assert.doesNotThrow(
      () => new AsyncFunction("page", "expect", "safeClick", "safeFill", bodyMatch[1]),
      `generated body should parse for input ${JSON.stringify(s)}`,
    );
  }
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  recorder tests failed");
  process.exit(1);
}

console.log("\n🎉 All recorder tests passed!");
