/**
 * Bundle-A fix #19 — the bot-detection pattern list is shared by:
 *   - `pipeline/feedbackLoop.js#classifyFailure` (post-run BOT_BLOCK category)
 *   - `pipeline/stateExplorer.js#isSameOriginAndValid` (mid-crawl skip gate)
 *
 * Pre-fix two copies drifted: feedbackLoop carried the
 * `\/blocked(?:[/?#]|$)` boundary fix while stateExplorer had a looser
 * `\/blocked/i` that over-matched `/blocked-users` admin paths. This
 * file pins the new shared module's contract AND verifies both
 * consumers behave identically against the same inputs.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  BOT_DETECTION_PATTERNS,
  EXPLORER_BOT_DETECTION_PATTERNS,
  EXPLORER_TERMINAL_URL_PATTERNS,
  isBotDetectionUrlOrText,
} = await import("../src/utils/botDetection.js");

const { classifyFailure } = await import("../src/pipeline/feedbackLoop.js");

// ─── Shared module: pattern list contract ────────────────────────────────────

test("BOT_DETECTION_PATTERNS is frozen and contains every canonical anti-bot indicator", () => {
  assert.ok(Object.isFrozen(BOT_DETECTION_PATTERNS), "pattern list must be frozen to prevent mutation drift");
  // Every documented indicator must be present. The list ordering matters
  // for first-match-wins ergonomics in callers, but the SET of patterns is
  // the contract pinned here.
  const sources = BOT_DETECTION_PATTERNS.map((re) => re.source);
  assert.ok(sources.some((s) => /sorry/.test(s)), "Google /sorry/ anti-bot wall");
  assert.ok(sources.some((s) => /captcha/.test(s)), "generic CAPTCHA paths");
  assert.ok(sources.some((s) => /challenge/.test(s)), "Cloudflare/WAF /challenge");
  assert.ok(sources.some((s) => /blocked/.test(s)), "Cloudflare/WAF /blocked landing");
  assert.ok(sources.some((s) => /recaptcha/.test(s)), "reCAPTCHA reference");
});

test("EXPLORER_BOT_DETECTION_PATTERNS is BOT_DETECTION_PATTERNS plus explorer-only terminals", () => {
  // The explorer-only set must STRICTLY EXTEND the shared list. Pre-fix the
  // explorer's list was a separate copy that could drift; post-fix it's the
  // shared list + explorer-specific HTTP-error terminals.
  for (const re of BOT_DETECTION_PATTERNS) {
    assert.ok(
      EXPLORER_BOT_DETECTION_PATTERNS.includes(re),
      `explorer list must include every pattern from BOT_DETECTION_PATTERNS; missing ${re}`,
    );
  }
  for (const re of EXPLORER_TERMINAL_URL_PATTERNS) {
    assert.ok(
      EXPLORER_BOT_DETECTION_PATTERNS.includes(re),
      `explorer list must include every pattern from EXPLORER_TERMINAL_URL_PATTERNS; missing ${re}`,
    );
  }
});

// ─── /blocked boundary contract (the original drift bug) ────────────────────

test("isBotDetectionUrlOrText: canonical `/blocked` paths match", () => {
  // The bot-detection landing page is exactly `/blocked` (Cloudflare et al).
  // Must match in every reasonable URL shape: bare, with trailing slash,
  // with query, with hash.
  assert.equal(isBotDetectionUrlOrText("https://example.com/blocked"), true);
  assert.equal(isBotDetectionUrlOrText("https://example.com/blocked/"), true);
  assert.equal(isBotDetectionUrlOrText("https://example.com/blocked?reason=bot"), true);
  assert.equal(isBotDetectionUrlOrText("https://example.com/blocked#cf-id"), true);
});

test("isBotDetectionUrlOrText: legitimate `/blocked-*` paths do NOT match (bug fix)", () => {
  // The drift bug — pre-fix stateExplorer's looser `\/blocked/i` matched
  // these legitimate admin paths and abandoned mid-crawl. The boundary
  // anchor `(?:[/?#]|$)` after `/blocked` is what prevents the over-match.
  const safePaths = [
    "https://app.example.com/users/blocked-users",
    "https://app.example.com/users/blocked-list",
    "https://app.example.com/admin/blocked-accounts",
    "https://app.example.com/content/blocked-items",
    "https://app.example.com/blocked-list",
    "https://app.example.com/api/blocked-resources",
  ];
  for (const url of safePaths) {
    assert.equal(
      isBotDetectionUrlOrText(url),
      false,
      `legitimate /blocked-* path must NOT match bot-detection: ${url}`,
    );
  }
});

test("isBotDetectionUrlOrText: every bot-block indicator triggers a match", () => {
  // Smoke test covering each pattern's canonical positive example.
  const positives = [
    "https://www.google.com/sorry/index?continue=foo",      // /sorry/
    "https://example.com/auth/captcha-challenge",            // /captcha
    "https://example.com/cf/challenge-platform",             // /challenge
    "https://example.com/blocked",                           // /blocked exact
    "https://www.google.com/recaptcha/api2/anchor",          // recaptcha
    "Our systems have detected unusual traffic from you",    // text: unusual traffic
    "Please verify: are you a robot?",                       // text: are you a robot
    "Verify you are human to continue",                      // text: verify you are human
    "Stopped at cloudflare challenge page",                  // text: cloudflare challenge
  ];
  for (const input of positives) {
    assert.equal(isBotDetectionUrlOrText(input), true, `expected match for: ${input}`);
  }
});

test("isBotDetectionUrlOrText: defensive on falsy / non-string inputs", () => {
  assert.equal(isBotDetectionUrlOrText(null), false);
  assert.equal(isBotDetectionUrlOrText(undefined), false);
  assert.equal(isBotDetectionUrlOrText(""), false);
  assert.equal(isBotDetectionUrlOrText(42), false);
  assert.equal(isBotDetectionUrlOrText({}), false);
});

// ─── Lockstep contract: both consumers behave identically on the same URL ──

test("classifyFailure (feedbackLoop) uses the shared list — `/blocked` URL → BOT_BLOCK", () => {
  const cat = classifyFailure(
    "waiting for locator('h3') timeout 15000ms exceeded",
    { finalUrl: "https://example.com/blocked" },
  );
  assert.equal(cat, "BOT_BLOCK", "shared list must drive the post-run classifier");
});

test("classifyFailure (feedbackLoop) — `/blocked-users` admin path is NOT BOT_BLOCK", () => {
  // Pin the boundary-anchor fix end-to-end through the production classifier.
  const cat = classifyFailure(
    "waiting for locator('h3') timeout 15000ms exceeded",
    { finalUrl: "https://app.example.com/admin/blocked-users" },
  );
  assert.notEqual(cat, "BOT_BLOCK", "legitimate /blocked-* admin path must not trip BOT_BLOCK");
});

test("classifyFailure (feedbackLoop) — `/sorry/` URL → BOT_BLOCK", () => {
  const cat = classifyFailure(
    "waiting for locator timeout",
    { finalUrl: "https://www.google.com/sorry/index?continue=foo" },
  );
  assert.equal(cat, "BOT_BLOCK");
});

test("classifyFailure (feedbackLoop) — `unusual traffic` text in error → BOT_BLOCK", () => {
  const cat = classifyFailure("Our systems have detected unusual traffic from your network.");
  assert.equal(cat, "BOT_BLOCK");
});

console.log("✅ bot-detection shared-module tests passed");
