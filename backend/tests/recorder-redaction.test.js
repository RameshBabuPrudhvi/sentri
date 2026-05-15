/**
 * @module tests/recorder-redaction
 * @description SEC-007 — credential-redaction pipeline coverage.
 *
 * Industry-standard autonomous QA platforms (Mabl, Testim, BearQ) mask
 * password / OTP / payment-card / operator-marked fields at capture time
 * so credentials never enter the persisted test record. This file locks
 * down the five-layer defence shipped in SEC-007:
 *
 *   1. In-page `isSensitiveField()` detects sensitive inputs.
 *   2. In-page `sentinelFor()` issues stable `__SENTRI_SECRET_<n>__`.
 *   3. Node-side `_looksLikeSecretValue()` defence-in-depth check.
 *   4. Codegen rewrites sentinel fills to `process.env.SENTRI_SECRET_<n>`.
 *   5. `recordedActionToStepText` renders redacted fills as `[REDACTED]`.
 *
 * Source-level assertions cover the in-page IIFE (runs only inside a
 * Chromium page context — Node can't import the page-side functions).
 * Behavioural assertions cover the Node-side codegen + step prose.
 * Mirrors the source-level pattern established in `recorder-pause.test.js`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  actionsToPlaywrightCode,
  recordedActionToStepText,
} from "../src/runner/recorder.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

const here = fileURLToPath(new URL(".", import.meta.url));
const RECORDER_SRC = fs.readFileSync(`${here}../src/runner/recorder.js`, "utf8");

console.log("\nrecorder-redaction — Layer 1: in-page isSensitiveField (source-level)");

test("isSensitiveField is defined inside RECORDER_SCRIPT before the input listener", () => {
  assert.match(RECORDER_SRC, /function isSensitiveField\(el\)/);
  const detectorIdx = RECORDER_SRC.indexOf("function isSensitiveField(el)");
  const inputListenerIdx = RECORDER_SRC.indexOf('document.addEventListener("input"');
  assert.ok(
    detectorIdx > 0 && inputListenerIdx > detectorIdx,
    "isSensitiveField must be defined before the input listener that calls it",
  );
});

test("isSensitiveField checks all four documented signals", () => {
  // Bounded read so a later occurrence of these patterns elsewhere in
  // the file can't cause a false pass.
  const fnBody = RECORDER_SRC.slice(
    RECORDER_SRC.indexOf("function isSensitiveField(el)"),
    RECORDER_SRC.indexOf("function sentinelFor("),
  );
  assert.match(fnBody, /el\.type === "password"/, "must check type=password");
  assert.match(fnBody, /autocomplete/i, "must check autocomplete hint");
  assert.match(fnBody, /current-password|new-password|one-time-code|cc-number/, "must enumerate autocomplete tokens");
  assert.match(fnBody, /data-sentri-secret/, "must check operator-marked data attribute");
  assert.match(fnBody, /password|passwd|pwd|secret|pin|cvv|cvc/, "must check name/id heuristic");
});

test("RECORDER_SCRIPT routes sensitive fills through sentinelFor in all four fill handlers", () => {
  // input + flushPendingFill + paste + change = 4 minimum call sites.
  // Missing any one re-opens the leak for that specific code path.
  const sentinelCalls = (RECORDER_SRC.match(/sentinelFor\(/g) || []).length;
  assert.ok(
    sentinelCalls >= 4,
    `expected >=4 sentinelFor() call sites (input, flushPendingFill, paste, change); found ${sentinelCalls}`,
  );
});

test("RECORDER_SCRIPT input handler routes sensitive values via ternary", () => {
  assert.match(
    RECORDER_SRC,
    /sensitive \? sentinelFor\(/,
    "input handler must use ternary to route sensitive fills through sentinelFor",
  );
});

console.log("\nrecorder-redaction — Layer 3: server-side _looksLikeSecretValue");

test("_looksLikeSecretValue exists at module scope with all documented patterns", () => {
  const fnIdx = RECORDER_SRC.indexOf("function _looksLikeSecretValue(value)");
  assert.ok(fnIdx > 0, "_looksLikeSecretValue must be defined at module scope");
  const body = RECORDER_SRC.slice(fnIdx, fnIdx + 2500);
  assert.match(body, /__SENTRI_SECRET_/, "must short-circuit on existing sentinels");
  assert.match(body, /eyJ/, "must detect JWT");
  assert.match(body, /AKIA/, "must detect AWS access key id");
  assert.match(body, /Bearer/i, "must detect Bearer token");
  assert.match(body, /sk_\(\?:live\|test\)/, "must detect Stripe-style live/test keys");
  assert.match(body, /gh\[poas\]_/, "must detect GitHub token prefixes");
  assert.match(body, /xox\[abps\]/, "must detect Slack token prefixes");
  assert.match(body, /_luhnValid\(/, "must Luhn-check credit-card-shaped values");
});

test("Luhn helper accepts valid card numbers and rejects invalid ones", () => {
  // _luhnValid is intentionally non-exported (narrow production API surface).
  // Extract + eval for testing — pure function, no side effects.
  const luhnIdx = RECORDER_SRC.indexOf("function _luhnValid(digits)");
  assert.ok(luhnIdx > 0, "_luhnValid must exist");
  const end = RECORDER_SRC.indexOf("\n}\n", luhnIdx);
  const fnSrc = RECORDER_SRC.slice(luhnIdx, end + 2);
  // eslint-disable-next-line no-eval
  const fn = eval(`(${fnSrc.replace("function _luhnValid", "function")})`);
  // Stripe's documented test card numbers — known-valid Luhn checksums.
  for (const ok of ["4242424242424242", "5555555555554444", "378282246310005"]) {
    assert.equal(fn(ok), true, `expected ${ok} to pass Luhn`);
  }
  // Mutate the last digit → known-invalid siblings.
  for (const bad of ["4242424242424241", "5555555555554443", "378282246310004"]) {
    assert.equal(fn(bad), false, `expected ${bad} to fail Luhn`);
  }
  assert.equal(fn("abc1234567890"), false, "non-digit input must be rejected without throwing");
});

console.log("\nrecorder-redaction — Layer 4: codegen rewrites sentinels to process.env");

test("actionsToPlaywrightCode rewrites a redacted fill to process.env.SENTRI_SECRET_N", () => {
  // Canonical case from the bug report: operator types `Test123456@` into a
  // password field; the in-page rule converts to sentinel; codegen routes
  // through env. The plaintext password must never appear in the output.
  const code = actionsToPlaywrightCode("login test", "https://example.com", [
    { kind: "fill", selector: "#email", label: "Email", value: "user@example.com", ts: 1 },
    { kind: "fill", selector: "#password", label: "Password", value: "__SENTRI_SECRET_1__", redacted: true, ts: 2 },
    { kind: "click", selector: 'role=button[name="Sign in"]', label: "Sign in", ts: 3 },
  ]);
  assert.match(code, /safeFill\(page, '#email', 'user@example\.com'\);/);
  assert.match(code, /process\.env\.SENTRI_SECRET_1/, "redacted fill must reference env var");
  assert.match(code, /throw new Error\('SEC-007/, "must emit fail-fast guard when env var is unset");
  assert.doesNotMatch(code, /__SENTRI_SECRET_1__/, "sentinel must be rewritten, not echoed");
  // Regression guard: the canonical leaked password (from the original bug
  // report) must NEVER appear in the output.
  assert.doesNotMatch(code, /Test123456@/);
});

test("actionsToPlaywrightCode handles the AUTO sentinel from server-side fallback", () => {
  const code = actionsToPlaywrightCode("auto test", "https://example.com", [
    { kind: "fill", selector: "#token", label: "Token", value: "__SENTRI_SECRET_AUTO__", redacted: true, ts: 1 },
  ]);
  assert.match(code, /process\.env\.SENTRI_SECRET_AUTO/);
  assert.match(code, /throw new Error\('SEC-007/);
});

test("actionsToPlaywrightCode leaves non-sensitive fills unchanged", () => {
  const code = actionsToPlaywrightCode("search test", "https://example.com", [
    { kind: "fill", selector: "#q", label: "Search", value: "playwright", ts: 1 },
  ]);
  assert.match(code, /safeFill\(page, '#q', 'playwright'\);/);
  assert.doesNotMatch(code, /process\.env\.SENTRI_SECRET/);
});

console.log("\nrecorder-redaction — Layer 5: step prose renders [REDACTED]");

test("recordedActionToStepText renders redacted fills as [REDACTED] via explicit marker", () => {
  assert.equal(
    recordedActionToStepText({
      kind: "fill", selector: "#pw", label: "Password",
      value: "__SENTRI_SECRET_1__", redacted: true, ts: 1,
    }),
    "User fills in the 'Password' field with [REDACTED]",
  );
});

test("recordedActionToStepText falls back to sentinel-pattern detection without marker", () => {
  // Defensive: a legacy action (e.g. persisted across a hot reload) still
  // has the sentinel value and must render redacted even without the marker.
  assert.equal(
    recordedActionToStepText({
      kind: "fill", selector: "#pw", label: "Password",
      value: "__SENTRI_SECRET_2__", ts: 1,
    }),
    "User fills in the 'Password' field with [REDACTED]",
  );
});

test("recordedActionToStepText leaves non-sensitive fills unchanged", () => {
  assert.equal(
    recordedActionToStepText({
      kind: "fill", selector: "#email", label: "Email",
      value: "user@example.com", ts: 1,
    }),
    "User fills in the 'Email' field with 'user@example.com'",
  );
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\nrecorder-redaction tests failed");
  process.exit(1);
}

console.log("\nAll recorder-redaction tests passed!");
