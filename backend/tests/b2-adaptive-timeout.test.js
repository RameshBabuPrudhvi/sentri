/**
 * @module tests/b2-adaptive-timeout
 * @description AUDIT-ROADMAP Bundle 2 — pure-function contracts.
 *
 * Locks in the deterministic shape of:
 *   - `testRunner.p95`                       — R-7 linear-interpolation percentile
 *   - `testRunner.computeAdaptiveElementTimeout` — `2 * p95` clamped to [floor, ceiling]
 *   - `crawlBrowser.shouldEnumerateFrame`    — iframe-strategy gate
 *   - `selfHealing.getSelfHealingHelperCode` — adaptive-timeout injection
 *
 * Scope note: browser-level iframe enumeration + SPA hydration are observed
 * in production via the B2 Prometheus metrics (`app_iframe_enumerated_total`,
 * `app_spa_hydration_wait_seconds`, `app_run_p95_load_ms`,
 * `app_run_adaptive_timeout_ms` in `utils/metrics.js`). End-to-end Playwright
 * coverage of those paths is out of scope for this file — the audit-roadmap
 * spec only requires unit-level contracts (matches B1's bar). This file is
 * registered in `backend/tests/run-tests.js`.
 */

import assert from "node:assert/strict";
import { p95, computeAdaptiveElementTimeout } from "../src/testRunner.js";
import { shouldEnumerateFrame } from "../src/pipeline/crawlBrowser.js";
import { getSelfHealingHelperCode } from "../src/selfHealing.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const runner = t.createTestRunner();

async function main() {
  // ── p95 — R-7 / NumPy default / Excel PERCENTILE.INC contract ─────────
  await runner.test("p95: empty / non-array returns null (caller falls back to floor)", () => {
    assert.equal(p95([]), null);
    assert.equal(p95(undefined), null);
    assert.equal(p95(null), null);
    assert.equal(p95("not an array"), null);
  });

  await runner.test("p95: rejects non-finite and negative entries before interpolation", () => {
    assert.equal(p95([NaN, Infinity, -100]), null);
    // Filtered set is [50] → p95 of a single value is that value.
    assert.equal(p95([NaN, 50, Infinity]), 50);
  });

  await runner.test("p95: single-value input returns that value (no division-by-zero)", () => {
    assert.equal(p95([1200]), 1200);
  });

  await runner.test("p95: linear interpolation between adjacent ranks (R-7)", () => {
    // For [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] the rank is
    // 0.95 * (10 - 1) = 8.55 — between index 8 (900) and 9 (1000),
    // interpolated: 900 + (1000 - 900) * 0.55 = 955.
    // Tolerate IEEE-754 drift: `100 * 0.55 + 900` produces 954.9999999999999
    // on x64 / arm64. Industry-standard percentile consumers (Prometheus
    // `histogram_quantile`, NumPy, Postgres) all accept sub-millisecond
    // float noise — the production callsite at `testRunner.js#computeAdaptiveElementTimeout`
    // immediately `Math.round`s the value before clamping, so the drift
    // never reaches the runtime.
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const result = p95(values);
    assert.ok(Math.abs(result - 955) < 1e-9,
      `expected p95 ≈ 955 within 1e-9 tolerance, got ${result}`);
  });

  await runner.test("p95: sorts input before computing (insensitive to caller order)", () => {
    const shuffled = [500, 100, 900, 300, 700, 200, 800, 400, 1000, 600];
    const result = p95(shuffled);
    assert.ok(Math.abs(result - 955) < 1e-9,
      `expected sorted p95 ≈ 955 within 1e-9 tolerance, got ${result}`);
  });

  // ── computeAdaptiveElementTimeout — `2 * p95` clamped to [floor, ceil] ─
  await runner.test("adaptive: null p95 returns the floor (no crawl-timing data)", () => {
    assert.equal(computeAdaptiveElementTimeout(null), 5000);
    assert.equal(computeAdaptiveElementTimeout(undefined), 5000);
  });

  await runner.test("adaptive: fast page (p95=1000ms) clamps up to the floor", () => {
    // 2 * 1000 = 2000ms, below floor 5000 → floor wins.
    assert.equal(computeAdaptiveElementTimeout(1000), 5000);
  });

  await runner.test("adaptive: moderate p95 (p95=8000ms) returns 2 * p95 unclamped", () => {
    // 2 * 8000 = 16000, inside [5000, 30000].
    assert.equal(computeAdaptiveElementTimeout(8000), 16000);
  });

  await runner.test("adaptive: slow outlier (p95=120000ms) clamps down to the ceiling", () => {
    // 2 * 120000 = 240000, above ceiling 30000 → ceiling wins.
    assert.equal(computeAdaptiveElementTimeout(120000), 30000);
  });

  await runner.test("adaptive: custom floor + ceiling are honoured", () => {
    // p95 = 4000 → 2x = 8000 inside [1000, 10000].
    assert.equal(computeAdaptiveElementTimeout(4000, { floor: 1000, ceiling: 10000 }), 8000);
    // p95 = 200 → 2x = 400 below custom floor 1000 → floor.
    assert.equal(computeAdaptiveElementTimeout(200, { floor: 1000, ceiling: 10000 }), 1000);
  });

  await runner.test("adaptive: non-finite p95 falls through to floor", () => {
    assert.equal(computeAdaptiveElementTimeout(NaN), 5000);
    assert.equal(computeAdaptiveElementTimeout(Infinity), 5000);
    assert.equal(computeAdaptiveElementTimeout(-1), 5000);
  });

  // ── shouldEnumerateFrame — iframe strategy gate ───────────────────────
  await runner.test("shouldEnumerateFrame: about:blank is always rejected", () => {
    assert.equal(shouldEnumerateFrame("about:blank", "https://app.example.com", "all"), false);
    assert.equal(shouldEnumerateFrame("about:blank", "https://app.example.com", "same-origin"), false);
  });

  await runner.test("shouldEnumerateFrame: 'none' strategy rejects every frame", () => {
    assert.equal(shouldEnumerateFrame("https://app.example.com/widget", "https://app.example.com", "none"), false);
  });

  await runner.test("shouldEnumerateFrame: 'all' accepts cross-origin frames", () => {
    assert.equal(shouldEnumerateFrame("https://js.stripe.com/v3/", "https://shop.example.com", "all"), true);
  });

  await runner.test("shouldEnumerateFrame: 'same-origin' accepts same-origin, rejects cross-origin", () => {
    assert.equal(shouldEnumerateFrame("https://app.example.com/widget", "https://app.example.com", "same-origin"), true);
    assert.equal(shouldEnumerateFrame("https://js.stripe.com/v3/", "https://shop.example.com", "same-origin"), false);
  });

  await runner.test("shouldEnumerateFrame: 'allowlist' accepts only URL-prefix matches", () => {
    const list = ["https://js.stripe.com/", "https://widget.intercom.io/"];
    assert.equal(shouldEnumerateFrame("https://js.stripe.com/v3/elements", "https://shop.example.com", "allowlist", list), true);
    assert.equal(shouldEnumerateFrame("https://widget.intercom.io/abc123", "https://shop.example.com", "allowlist", list), true);
    assert.equal(shouldEnumerateFrame("https://evil.example.com/", "https://shop.example.com", "allowlist", list), false);
  });

  await runner.test("shouldEnumerateFrame: 'allowlist' with empty list rejects everything", () => {
    assert.equal(shouldEnumerateFrame("https://js.stripe.com/v3/", "https://shop.example.com", "allowlist", []), false);
    assert.equal(shouldEnumerateFrame("https://js.stripe.com/v3/", "https://shop.example.com", "allowlist"), false);
  });

  // ── selfHealing helper string carries the adaptive timeout ────────────
  await runner.test("selfHealing: explicit elementTimeout is baked into DEFAULT_TIMEOUT", () => {
    const code = getSelfHealingHelperCode({}, { elementTimeout: 17000 });
    assert.match(code, /const DEFAULT_TIMEOUT = 17000;/,
      "elementTimeout did not propagate into the emitted helper string");
  });

  await runner.test("selfHealing: omitted elementTimeout falls back to env default (5000)", () => {
    const code = getSelfHealingHelperCode({});
    // The env default is `HEALING_ELEMENT_TIMEOUT` which defaults to 5000
    // when the env var is unset (matches the constant at the top of
    // `selfHealing.js`).
    assert.match(code, /const DEFAULT_TIMEOUT = 5000;/,
      "omitted elementTimeout did not fall back to the env default");
  });

  await runner.test("selfHealing: garbage elementTimeout values fall back safely", () => {
    // NaN / negative / non-integer must not corrupt the emitted constant.
    const cases = [NaN, -1, 1.5, "12000", null];
    for (const bad of cases) {
      const code = getSelfHealingHelperCode({}, { elementTimeout: bad });
      assert.match(code, /const DEFAULT_TIMEOUT = 5000;/,
        `bad elementTimeout=${String(bad)} should fall back to env default`);
    }
  });

  runner.summary("b2-adaptive-timeout");
}

main().catch((err) => {
  console.error("❌ b2-adaptive-timeout failed:", err);
  process.exit(1);
});
