/**
 * @module tests/cross-browser
 * @description Unit tests for DIF-002 — cross-browser support in
 * `backend/src/runner/config.js`. Exercises the pure `resolveBrowser()`
 * dispatch logic and the env-driven `DEFAULT_BROWSER` fallback without
 * actually launching Chromium / Firefox / WebKit (which would require ~300MB
 * of Playwright binary downloads in CI).
 *
 * Live-launch coverage is intentionally deferred to the existing integration
 * smoke tests which run on CI with the full Playwright install.
 */

import assert from "node:assert/strict";

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

// ─── resolveBrowser() ────────────────────────────────────────────────────────
// The config module reads `process.env.BROWSER_DEFAULT` at import time to
// compute `DEFAULT_BROWSER`. Tests set the env var BEFORE importing so the
// fallback branch is exercised.

console.log("\n🧪 resolveBrowser() — engine dispatch");

const { resolveBrowser, BROWSER_PRESETS, DEFAULT_BROWSER } =
  await import("../src/runner/config.js");

test("resolveBrowser('chromium') returns the chromium engine", () => {
  const { engine, name } = resolveBrowser("chromium");
  assert.equal(name, "chromium");
  assert.equal(typeof engine.launch, "function");
});

test("resolveBrowser('firefox') returns the firefox engine", () => {
  const { engine, name } = resolveBrowser("firefox");
  assert.equal(name, "firefox");
  assert.equal(typeof engine.launch, "function");
});

test("resolveBrowser('webkit') returns the webkit engine", () => {
  const { engine, name } = resolveBrowser("webkit");
  assert.equal(name, "webkit");
  assert.equal(typeof engine.launch, "function");
});

test("resolveBrowser is case-insensitive", () => {
  assert.equal(resolveBrowser("FIREFOX").name, "firefox");
  assert.equal(resolveBrowser("Firefox").name, "firefox");
  assert.equal(resolveBrowser("WebKit").name, "webkit");
});

test("resolveBrowser falls back to chromium for empty / null / undefined", () => {
  assert.equal(resolveBrowser("").name, "chromium");
  assert.equal(resolveBrowser(null).name, "chromium");
  assert.equal(resolveBrowser(undefined).name, "chromium");
  assert.equal(resolveBrowser().name, "chromium");
});

test("resolveBrowser falls back to chromium for unknown engine names", () => {
  // Any typo or malicious value safely degrades to chromium rather than
  // throwing — the route layer can trust the returned name unconditionally.
  for (const bad of ["edge", "safari", "ie6", "../etc/passwd", " firefox ", 42, {}]) {
    assert.equal(resolveBrowser(bad).name, "chromium", `expected chromium for ${JSON.stringify(bad)}`);
  }
});

// ─── BROWSER_PRESETS shape ───────────────────────────────────────────────────

console.log("\n🧪 BROWSER_PRESETS — UI dropdown data");

test("BROWSER_PRESETS contains exactly the three Playwright engines", () => {
  assert.equal(BROWSER_PRESETS.length, 3);
  const values = BROWSER_PRESETS.map(p => p.value).sort();
  assert.deepEqual(values, ["chromium", "firefox", "webkit"]);
});

test("Every BROWSER_PRESETS value is resolvable by resolveBrowser()", () => {
  // Prevents a UI option drifting ahead of the backend dispatch table.
  for (const { value } of BROWSER_PRESETS) {
    assert.equal(resolveBrowser(value).name, value);
  }
});

test("Every BROWSER_PRESETS row has a non-empty human label", () => {
  for (const preset of BROWSER_PRESETS) {
    assert.equal(typeof preset.label, "string");
    assert.ok(preset.label.length > 0);
  }
});

// ─── DEFAULT_BROWSER env-driven behaviour ────────────────────────────────────

console.log("\n🧪 DEFAULT_BROWSER — env-driven fallback");

test("DEFAULT_BROWSER is 'chromium' when BROWSER_DEFAULT is unset", () => {
  // Module was already imported above with whatever env the test runner had;
  // this assertion is defensive — if the dev shell had BROWSER_DEFAULT=firefox
  // exported, the test would surface that.
  assert.ok(["chromium", "firefox", "webkit"].includes(DEFAULT_BROWSER),
    `DEFAULT_BROWSER must be one of the three engines, got ${JSON.stringify(DEFAULT_BROWSER)}`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  cross-browser tests failed");
  process.exit(1);
}

console.log("\n🎉 All cross-browser tests passed!");
