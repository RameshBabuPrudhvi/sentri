/**
 * @module tests/dns-classification
 * @description Regression tests for E1 — DNS-invalid crawls must be classified
 * as `failed` with a DNS-specific hint instead of silently completing as
 * "Completed (empty)". Covers:
 *
 *   - `categoriseNavigationError()` in `pipeline/crawlBrowser.js` — the new
 *     coarse classifier used to decide whether a totally-unreachable target
 *     warrants throwing from the crawler.
 *   - `classifyError()` in `utils/errorClassifier.js` — specifically the new
 *     DNS branch that produces the "target host could not be resolved" hint
 *     (typo / hostname / VPN) instead of the generic NAVIGATION catch-all.
 *
 * Live E2E reproduction (pre-fix) was a crawl of `https://sentri-not-exist-12345.invalid`
 * showing `net::ERR_NAME_NOT_RESOLVED` in the Activity Log while the run
 * status stayed `completed_empty`. These assertions codify the fixed contract.
 */

import assert from "node:assert/strict";
import { categoriseNavigationError } from "../src/pipeline/crawlBrowser.js";
import { classifyError, ERROR_CATEGORY } from "../src/utils/errorClassifier.js";

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

// ── categoriseNavigationError — DNS branch ─────────────────────────────────
console.log("\n🧪 categoriseNavigationError — DNS branch");

test("Chromium 'net::ERR_NAME_NOT_RESOLVED' → 'dns'", () => {
  // The exact message Playwright surfaces for an unresolvable hostname.
  assert.equal(
    categoriseNavigationError("page.goto: net::ERR_NAME_NOT_RESOLVED at https://sentri-not-exist-12345.invalid"),
    "dns",
  );
});

test("Node.js 'ENOTFOUND' → 'dns'", () => {
  // Bare-fetch / pg / redis error messages can bubble ENOTFOUND through.
  assert.equal(categoriseNavigationError("getaddrinfo ENOTFOUND example.invalid"), "dns");
});

test("Our own 'DNS' marker message → 'dns'", () => {
  // The error thrown by crawler.js when the probe fails uses the literal
  // word "DNS" so errorClassifier's DNS branch can match it.
  assert.equal(
    categoriseNavigationError("Target host could not be resolved (DNS). not reachable"),
    "dns",
  );
});

test("case-insensitive matching (upper-case ERR_NAME_NOT_RESOLVED)", () => {
  assert.equal(categoriseNavigationError("ERR_NAME_NOT_RESOLVED"), "dns");
});

// ── categoriseNavigationError — network branch ─────────────────────────────
console.log("\n🧪 categoriseNavigationError — network branch");

for (const { code, label } of [
  { code: "ERR_CONNECTION_REFUSED",   label: "connection refused" },
  { code: "ERR_CONNECTION_RESET",     label: "connection reset" },
  { code: "ERR_CONNECTION_CLOSED",    label: "connection closed" },
  { code: "ERR_CONNECTION_TIMED_OUT", label: "connection timed out" },
  { code: "ERR_NETWORK",              label: "network failure" },
  { code: "ERR_ADDRESS_UNREACHABLE",  label: "address unreachable" },
  { code: "ERR_INTERNET_DISCONNECTED", label: "internet disconnected" },
  { code: "ERR_SSL_PROTOCOL_ERROR",   label: "ssl error" },
  { code: "ERR_CERT_AUTHORITY_INVALID", label: "cert error" },
  { code: "ECONNREFUSED",             label: "node econnrefused" },
  { code: "ECONNRESET",               label: "node econnreset" },
  { code: "ENETUNREACH",              label: "node enetunreach" },
]) {
  test(`'${code}' (${label}) → 'network'`, () => {
    assert.equal(categoriseNavigationError(`net::${code} at https://example.com`), "network");
  });
}

// ── categoriseNavigationError — timeout + other ────────────────────────────
console.log("\n🧪 categoriseNavigationError — timeout / other");

test("'Timeout 15000ms exceeded' → 'timeout'", () => {
  assert.equal(categoriseNavigationError("Timeout 15000ms exceeded"), "timeout");
});

test("'navigation timed out' → 'timeout'", () => {
  assert.equal(categoriseNavigationError("navigation timed out after 30000ms"), "timeout");
});

test("Unknown error message → 'other'", () => {
  assert.equal(categoriseNavigationError("some weird internal playwright error"), "other");
});

test("Empty / null / undefined message → 'other' (defensive)", () => {
  assert.equal(categoriseNavigationError(""), "other");
  assert.equal(categoriseNavigationError(null), "other");
  assert.equal(categoriseNavigationError(undefined), "other");
});

test("DNS wins over timeout when both keywords present", () => {
  // ERR_NAME_NOT_RESOLVED errors often co-occur with timeout wording because
  // Playwright retries until the navigation timeout fires. The DNS branch is
  // checked first so users see the DNS-specific hint.
  assert.equal(
    categoriseNavigationError("Navigation timeout: net::ERR_NAME_NOT_RESOLVED"),
    "dns",
  );
});

// ── errorClassifier.js — DNS branch ────────────────────────────────────────
console.log("\n🧪 classifyError — DNS branch");

test("net::ERR_NAME_NOT_RESOLVED → DNS-specific user message", () => {
  // This is the exact error `crawler.js` throws when the crawl produces zero
  // pages and every attempt failed with a DNS-class category.
  const res = classifyError(
    new Error('Target host could not be resolved (DNS). "https://sentri-not-exist.invalid" is not reachable — net::ERR_NAME_NOT_RESOLVED'),
    "crawl",
  );
  assert.equal(res.category, ERROR_CATEGORY.NAVIGATION);
  assert.match(res.message, /could not be resolved/i);
  assert.match(res.message, /typo/i,  "should mention typo check");
  assert.match(res.message, /VPN/,    "should mention VPN check");
});

test("ENOTFOUND (Node.js-level DNS) → DNS-specific user message", () => {
  const res = classifyError(new Error("getaddrinfo ENOTFOUND example.invalid"));
  assert.equal(res.category, ERROR_CATEGORY.NAVIGATION);
  assert.match(res.message, /could not be resolved/i);
});

test("Raw 'net::ERR_NAME_NOT_RESOLVED' → DNS-specific message (DNS before NAVIGATION)", () => {
  // Regression: without the DNS branch being checked BEFORE the generic
  // NAVIGATION branch, this would produce the catch-all "check that the
  // project URL is accessible" message and lose the typo/VPN hint.
  const res = classifyError(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://bad.invalid"));
  assert.equal(res.category, ERROR_CATEGORY.NAVIGATION);
  assert.match(res.message, /could not be resolved/i, "must be DNS-specific, not generic navigation");
  assert.doesNotMatch(res.message, /^Page navigation failed\./);
});

test("Generic navigation error (no DNS markers) → catch-all NAVIGATION message", () => {
  // Sanity check — the generic NAVIGATION branch still wins for non-DNS
  // failures so we don't regress existing behaviour.
  const res = classifyError(new Error("page.goto: net::ERR_CONNECTION_REFUSED at https://example.com"));
  assert.equal(res.category, ERROR_CATEGORY.NAVIGATION);
  assert.match(res.message, /Page navigation failed/);
  assert.doesNotMatch(res.message, /could not be resolved/i);
});

test("'unreachable' keyword → NAVIGATION (from the new unreachable match)", () => {
  // crawler.js throws `Target URL is unreachable — …` for non-DNS network
  // failures; classifyError should route this to NAVIGATION too.
  const res = classifyError(new Error("Target URL is unreachable — ERR_CONNECTION_REFUSED"));
  assert.equal(res.category, ERROR_CATEGORY.NAVIGATION);
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  dns-classification tests failed");
  process.exit(1);
}

console.log("\n🎉 All DNS classification tests passed!");
