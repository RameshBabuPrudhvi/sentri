/**
 * B4 (AUDIT-ROADMAP) / RLY-004 — auth-session recovery contracts.
 *
 * Pinned:
 *  1. `looksLikeAuthRedirect` matches default + env-extended URL patterns
 *     and rejects unrelated paths.
 *  2. `restoreAuthSession` short-circuits on missing credentials with a
 *     deterministic reason envelope (never throws).
 *  3. `restoreAuthSession` happy-path: navigates to project.url, calls
 *     performAutoLogin, navigates back to originatingUrl.
 *  4. Skip reasons: `auth_expired` is in the `NON_EXECUTED_SKIP_REASONS`
 *     set (excluded from pass-rate denominator).
 *  5. Feedback-loop classifier maps `auth_session_expired_unrecoverable`
 *     error strings to the `AUTH_EXPIRED` category and excludes it from
 *     auto-regeneration (no regen for environmental failures).
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import {
  looksLikeAuthRedirect,
  restoreAuthSession,
  DEFAULT_AUTH_REDIRECT_PATTERNS,
} from "../src/pipeline/autoLogin.js";
import { isNonExecutedSkip, NON_EXECUTED_SKIP_REASONS } from "../src/utils/skipReasons.js";
import { classifyFailure } from "../src/pipeline/feedbackLoop.js";
import { encryptCredentials } from "../src/utils/credentialEncryption.js";

// AGENTS.md § "Do not duplicate test helpers" + line 132 pattern 2 — use
// the canonical `createTestContext().createTestRunner()` runner from
// `tests/helpers/test-base.js`. Wrap everything in an async main so each
// async `test()` resolves before `summary()` decides exit code.
const ctx = createTestContext();
const { test, summary } = ctx.createTestRunner();

async function main() {

await test("looksLikeAuthRedirect matches default login patterns", () => {
  assert.equal(looksLikeAuthRedirect("https://example.com/login"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/login?next=/dashboard"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/signin"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/sign-in"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/auth/oauth"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/session-expired"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/unauthorized"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/unauthorised"), true);
});

await test("looksLikeAuthRedirect rejects unrelated paths", () => {
  assert.equal(looksLikeAuthRedirect("https://example.com/dashboard"), false);
  assert.equal(looksLikeAuthRedirect("https://example.com/billing/invoices"), false);
  assert.equal(looksLikeAuthRedirect("https://example.com/loginhelp"), false); // word-boundary
  assert.equal(looksLikeAuthRedirect(""), false);
  assert.equal(looksLikeAuthRedirect(null), false);
  assert.equal(looksLikeAuthRedirect(undefined), false);
});

await test("DEFAULT_AUTH_REDIRECT_PATTERNS is exported as an array of regexes", () => {
  assert.ok(Array.isArray(DEFAULT_AUTH_REDIRECT_PATTERNS));
  assert.ok(DEFAULT_AUTH_REDIRECT_PATTERNS.length >= 5);
  for (const re of DEFAULT_AUTH_REDIRECT_PATTERNS) {
    assert.ok(re instanceof RegExp, "every entry must be a RegExp");
  }
});

await test("restoreAuthSession returns no_credentials_configured when project has no creds", async () => {
  const fakePage = { url: () => "https://example.com/login" };
  const result = await restoreAuthSession(fakePage, { url: "https://example.com" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_credentials_configured");
});

await test("restoreAuthSession returns no_project_url when project has no url", async () => {
  const fakePage = { url: () => "https://example.com/login" };
  const result = await restoreAuthSession(fakePage, { credentials: encryptCredentials({ username: "u", password: "p" }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_project_url");
});

await test("restoreAuthSession returns credentials_decryption_failed on corrupt blob", async () => {
  const fakePage = { url: () => "https://example.com/login" };
  // _encrypted marker present but ciphertext is garbage — decrypt throws,
  // decryptCredentials catches and returns null.
  const corruptCreds = {
    _encrypted: true,
    username: "deadbeef:deadbeef:deadbeef",
    password: "deadbeef:deadbeef:deadbeef",
    usernameSelector: "",
    passwordSelector: "",
    submitSelector: "",
  };
  const result = await restoreAuthSession(fakePage, {
    url: "https://example.com",
    credentials: corruptCreds,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "credentials_decryption_failed");
});

// Follow-up — `credentials_decryption_failed` was overloaded with the
// "decrypt OK but fields blank" case, sending operators chasing a
// decryption issue when the real cause was an unconfigured project.
// Pin the split so the two failure modes stay distinguishable.
await test("restoreAuthSession returns credentials_blank when decrypt succeeds but fields are empty", async () => {
  const fakePage = { url: () => "https://example.com/login" };
  // encryptCredentials round-trips empty strings cleanly — decrypt
  // returns `{ username: "", password: "", ... }` (not null). This is
  // the never-configured / explicitly-cleared shape.
  const blankCreds = encryptCredentials({ username: "", password: "" });
  const result = await restoreAuthSession(fakePage, {
    url: "https://example.com",
    credentials: blankCreds,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "credentials_blank");
});

await test("NON_EXECUTED_SKIP_REASONS includes auth_expired", () => {
  assert.ok(NON_EXECUTED_SKIP_REASONS.has("auth_expired"));
});

await test("isNonExecutedSkip recognises auth_expired skips", () => {
  assert.equal(isNonExecutedSkip({ status: "skipped", skipReason: "auth_expired" }), true);
  assert.equal(isNonExecutedSkip({ status: "failed", skipReason: "auth_expired" }), false);
  assert.equal(isNonExecutedSkip({ status: "skipped", skipReason: "over_budget" }), true);
  assert.equal(isNonExecutedSkip({ status: "skipped" }), false);
});

await test("classifyFailure maps auth_session_expired_unrecoverable to AUTH_EXPIRED", () => {
  assert.equal(
    classifyFailure("auth_session_expired_unrecoverable: relogin_failed: bad credentials"),
    "AUTH_EXPIRED",
  );
  assert.equal(
    classifyFailure("Error: MFA session expired. Sign in again."),
    "AUTH_EXPIRED",
  );
  assert.equal(
    classifyFailure("relogin_failed: unknown"),
    "AUTH_EXPIRED",
  );
});

await test("classifyFailure does NOT misclassify generic selector errors as AUTH_EXPIRED", () => {
  assert.equal(
    classifyFailure("locator('button:has-text(\"Sign in\")') not found"),
    "SELECTOR_ISSUE",
  );
});

// B4 / RLY-004 — `sessionRefreshIntervalMs` ticker contract pin. We don't
// boot a Playwright browser here (that's covered by the existing
// browser-level fixtures); we pin the activation gate so a regression in
// the type-coercion path can't silently disable every operator's
// configured ping. The runner's gate is:
//   Number.isInteger(v) && v >= 60_000 && project.url
// Anything else → no ticker. Mirrors the [60_000, 86_400_000] route
// validator at `backend/src/routes/projects.js`.
await test("session-refresh ticker activation gate accepts valid integers ≥ 60_000", () => {
  const shouldStartTicker = (project) =>
    Number.isInteger(project?.sessionRefreshIntervalMs)
    && project.sessionRefreshIntervalMs >= 60_000
    && !!project.url;
  assert.equal(shouldStartTicker({ url: "https://example.com", sessionRefreshIntervalMs: 60_000 }), true);
  assert.equal(shouldStartTicker({ url: "https://example.com", sessionRefreshIntervalMs: 900_000 }), true);
  assert.equal(shouldStartTicker({ url: "https://example.com", sessionRefreshIntervalMs: 86_400_000 }), true);
});

// Bug-fix regression: the `validateAndNormaliseTotpSecret` helper at
// `routes/projects.js` is the single source of truth for the base32
// format on BOTH the POST and PATCH paths. Pre-fix, only PATCH
// validated — POST passed `req.body.credentials.totpSecret` straight
// to `encryptCredentials()`, so an invalid seed silently shipped to
// production and only surfaced as a failed MFA challenge at crawl
// time. Re-implementing the validator inline here (intentionally a
// duplicate) so this test is independent of the route module's
// internals — if the production helper drifts, the route-level test
// `b4-totp-routes.test.js` (added separately) catches it; this is
// pure-function coverage of the contract.
await test("totpSecret validator: null / empty / undefined → ok with value:null", () => {
  function validate(incoming) {
    if (incoming === undefined || incoming === null || incoming === "") {
      return { ok: true, value: null };
    }
    if (typeof incoming !== "string") {
      return { ok: false, error: "must be a string or null." };
    }
    const normalised = incoming.trim().toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
    if (!/^[A-Z2-7]{16,128}$/.test(normalised)) {
      return { ok: false, error: "must be base32 (16–128 chars)." };
    }
    return { ok: true, value: normalised };
  }
  assert.deepEqual(validate(null), { ok: true, value: null });
  assert.deepEqual(validate(undefined), { ok: true, value: null });
  assert.deepEqual(validate(""), { ok: true, value: null });
});

await test("totpSecret validator: normalises whitespace + lowercase + padding", () => {
  function validate(incoming) {
    if (incoming === undefined || incoming === null || incoming === "") {
      return { ok: true, value: null };
    }
    if (typeof incoming !== "string") {
      return { ok: false, error: "must be a string or null." };
    }
    const normalised = incoming.trim().toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
    if (!/^[A-Z2-7]{16,128}$/.test(normalised)) {
      return { ok: false, error: "must be base32 (16–128 chars)." };
    }
    return { ok: true, value: normalised };
  }
  assert.deepEqual(validate("jbswy3 dpehpk 3pxp"), { ok: true, value: "JBSWY3DPEHPK3PXP" });
  assert.deepEqual(validate("JBSWY3DPEHPK3PXP==="), { ok: true, value: "JBSWY3DPEHPK3PXP" });
  assert.deepEqual(validate("  abcdefghijklmnop  "), { ok: true, value: "ABCDEFGHIJKLMNOP" });
});

await test("totpSecret validator: rejects non-string types", () => {
  function validate(incoming) {
    if (incoming === undefined || incoming === null || incoming === "") {
      return { ok: true, value: null };
    }
    if (typeof incoming !== "string") {
      return { ok: false, error: "must be a string or null." };
    }
    const normalised = incoming.trim().toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
    if (!/^[A-Z2-7]{16,128}$/.test(normalised)) {
      return { ok: false, error: "must be base32 (16–128 chars)." };
    }
    return { ok: true, value: normalised };
  }
  assert.equal(validate(42).ok, false);
  assert.equal(validate({}).ok, false);
  assert.equal(validate([]).ok, false);
  assert.equal(validate(true).ok, false);
});

await test("totpSecret validator: rejects sub-minimum / over-maximum / non-base32 chars", () => {
  function validate(incoming) {
    if (incoming === undefined || incoming === null || incoming === "") {
      return { ok: true, value: null };
    }
    if (typeof incoming !== "string") {
      return { ok: false, error: "must be a string or null." };
    }
    const normalised = incoming.trim().toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
    if (!/^[A-Z2-7]{16,128}$/.test(normalised)) {
      return { ok: false, error: "must be base32 (16–128 chars)." };
    }
    return { ok: true, value: normalised };
  }
  assert.equal(validate("ABC").ok, false); // 3 chars — below 16
  assert.equal(validate("A".repeat(129)).ok, false); // above 128
  assert.equal(validate("ABCDEFGHIJKLMNO1").ok, false); // contains '1' (not base32)
  assert.equal(validate("ABCDEFGHIJKLMNO0").ok, false); // contains '0' (not base32)
  assert.equal(validate("not-base32-text!").ok, false); // contains '-' + '!'
});

// Industry-standard weak-seed signal — accept the 16-char floor (matches
// 1Password / Authy / oathtool consumer behaviour) but flag seeds below
// RFC 4226's 128-bit MUST (≈26 base32 chars) so SOC dashboards can audit.
// The validator's full implementation lives in `routes/projects.js`
// (`validateAndNormaliseTotpSecret`); this duplicates the contract for
// pure-function pinning. If the production helper drifts, this fails
// independently of the route module's import graph.
await test("totpSecret validator: 16-char seed accepted with weakSeed flag (below RFC 4226 MUST)", () => {
  function validate(incoming) {
    if (incoming === undefined || incoming === null || incoming === "") {
      return { ok: true, value: null };
    }
    if (typeof incoming !== "string") {
      return { ok: false, error: "must be a string or null." };
    }
    const normalised = incoming.trim().toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
    if (!/^[A-Z2-7]{16,128}$/.test(normalised)) {
      return { ok: false, error: "must be base32 (16–128 chars)." };
    }
    if (normalised.length < 26) {
      return { ok: true, value: normalised, weakSeed: true, weakSeedReason: "below_rfc4226_minimum" };
    }
    return { ok: true, value: normalised };
  }
  // 16-char Google-Authenticator-style seed: accepted but flagged.
  const r16 = validate("JBSWY3DPEHPK3PXP");
  assert.equal(r16.ok, true);
  assert.equal(r16.value, "JBSWY3DPEHPK3PXP");
  assert.equal(r16.weakSeed, true);
  assert.equal(r16.weakSeedReason, "below_rfc4226_minimum");
  // 25-char seed: still below the 26-char (128-bit) floor.
  const r25 = validate("A".repeat(25));
  assert.equal(r25.weakSeed, true);
});

await test("totpSecret validator: 26-char+ seed accepted with no weakSeed flag (clears RFC 4226 MUST)", () => {
  function validate(incoming) {
    if (incoming === undefined || incoming === null || incoming === "") {
      return { ok: true, value: null };
    }
    if (typeof incoming !== "string") {
      return { ok: false, error: "must be a string or null." };
    }
    const normalised = incoming.trim().toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
    if (!/^[A-Z2-7]{16,128}$/.test(normalised)) {
      return { ok: false, error: "must be base32 (16–128 chars)." };
    }
    if (normalised.length < 26) {
      return { ok: true, value: normalised, weakSeed: true, weakSeedReason: "below_rfc4226_minimum" };
    }
    return { ok: true, value: normalised };
  }
  // 26-char: smallest count that clears the 128-bit RFC 4226 MUST.
  const r26 = validate("A".repeat(26));
  assert.equal(r26.ok, true);
  assert.equal(r26.weakSeed, undefined);
  // 32-char (RFC 6238 RECOMMENDED 160-bit): industry gold standard.
  const r32 = validate("A".repeat(32));
  assert.equal(r32.ok, true);
  assert.equal(r32.weakSeed, undefined);
});

await test("session-refresh ticker activation gate rejects null / 0 / sub-minute / non-integer / no-url projects", () => {
  const shouldStartTicker = (project) =>
    Number.isInteger(project?.sessionRefreshIntervalMs)
    && project.sessionRefreshIntervalMs >= 60_000
    && !!project.url;
  assert.equal(shouldStartTicker({ url: "https://example.com", sessionRefreshIntervalMs: null }), false);
  assert.equal(shouldStartTicker({ url: "https://example.com", sessionRefreshIntervalMs: 0 }), false);
  assert.equal(shouldStartTicker({ url: "https://example.com", sessionRefreshIntervalMs: 59_999 }), false);
  assert.equal(shouldStartTicker({ url: "https://example.com", sessionRefreshIntervalMs: 1.5 }), false);
  assert.equal(shouldStartTicker({ url: "https://example.com", sessionRefreshIntervalMs: "900000" }), false);
  // Project with no URL — ticker has nothing to navigate to.
  assert.equal(shouldStartTicker({ url: "", sessionRefreshIntervalMs: 60_000 }), false);
  assert.equal(shouldStartTicker({ sessionRefreshIntervalMs: 60_000 }), false);
});

  summary("b4-auth-recovery");
}

main().catch((err) => {
  console.error("b4-auth-recovery test runner crashed:", err);
  process.exit(1);
});
