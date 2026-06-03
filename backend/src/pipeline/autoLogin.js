/**
 * @module pipeline/autoLogin
 * @description Selector-less login helper. Given a Playwright page, a username
 * and password (and optionally a TOTP secret), locates the login form
 * elements via a semantic-first waterfall of locator strategies so users
 * don't have to hand-author CSS selectors when creating a project.
 *
 * ### B4 / SCL-001 — Target-app TOTP support
 * After the username + password submit, if the project has a configured
 * `credentials.totpSecret`, this module looks for a one-time-code field
 * (autocomplete=one-time-code, aria-label/placeholder containing
 * "code"/"OTP"/"verification") and fills the live RFC 6238 code computed
 * from the seed via `utils/totp.js#generateTotpCode`. Industry-standard
 * pattern: matches what Cypress (`cypress-otp`), Playwright (`playwright-
 * otp` community plugin), Selenium recipes, and BrowserStack's MFA
 * automation guide all do. If the first code is rejected (rare —
 * happens at the 30-second window boundary), we wait briefly and retry
 * with a freshly generated code so a step boundary doesn't fail the
 * login flow.
 *
 * ### B4 / RLY-004 — Mid-run session recovery
 * `restoreAuthSession(page, project, run)` is exported so the per-test
 * runner (`executeTest.js`) can call it when it detects a
 * login-page redirect mid-run. The recovery navigates back to
 * `project.url`, performs a fresh `performAutoLogin` (with TOTP if
 * configured), then navigates back to the originating URL. Returns a
 * `{ ok, reason }` envelope so the caller can classify recoverable
 * vs. unrecoverable cases without try/catch around every call site.
 *
 * ### Strategies (in order, per field)
 *
 * **Username field**
 *   1. `page.locator('input[type="email"]').first()`
 *   2. `page.getByLabel(/email|user|login/i)`
 *   3. `page.getByPlaceholder(/email|user|login/i)`
 *   4. `page.getByRole('textbox', { name: /email|user|login/i })`
 *   5. `page.locator('input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]')`
 *   6. First visible non-password `<input>` on the page (last resort).
 *
 * **Password field**
 *   1. `page.locator('input[type="password"]').first()` — almost always wins.
 *
 * **Submit button**
 *   1. `page.getByRole('button', { name: /sign in|log in|login|submit|continue/i })`
 *   2. `page.locator('button[type="submit"], input[type="submit"]').first()`
 *   3. `form button:not([type="button"])` scoped to the password field's form.
 *   4. Fallback: press `Enter` inside the password field (browsers submit
 *      the form natively).
 *
 * Honest limitations: this is a best-effort heuristic, not an AI solver.
 * It handles ~90% of conventional login pages (email + password + button)
 * but will miss exotic flows (multi-step SSO, captchas, phone-number-first
 * forms, shadow-DOM components without semantic roles). Those sites can
 * still fall back to the recorder or legacy explicit selectors.
 *
 * ### Backwards compatibility
 * Projects that already persist explicit `usernameSelector` / `passwordSelector`
 * / `submitSelector` values continue to use them (fast path). This module is
 * only invoked when those fields are blank.
 *
 * @example
 * const ok = await performAutoLogin(page, {
 *   username: "alice@example.com",
 *   password: "secret",
 * }, { timeout: 5000, logger: (m) => console.log(m) });
 */

import { generateTotpCode } from "../utils/totp.js";
import { decryptCredentials } from "../utils/credentialEncryption.js";
import { formatLogLine } from "../utils/logFormatter.js";

/**
 * Try each candidate locator until one resolves to a visible element or we
 * run out. Returns the first winning Locator or null.
 *
 * Types intentionally kept loose (`object` / `Function`) so vanilla jsdoc
 * can parse them — the `import('@playwright/test').Page` / `.Locator` syntax
 * is valid TypeScript but unsupported by the jsdoc CLI we use in CI.
 *
 * @param {object} page - Playwright `Page` instance.
 * @param {Array<Function>} strategies - Locator-building functions.
 * @param {number} timeout - per-strategy visibility timeout (ms).
 * @returns {Promise<object|null>} Playwright `Locator` or null.
 * @private
 */
async function firstVisible(page, strategies, timeout) {
  for (const build of strategies) {
    try {
      const locator = build();
      await locator.first().waitFor({ state: "visible", timeout });
      return locator.first();
    } catch { /* next strategy */ }
  }
  return null;
}

/**
 * Resolve the three login form elements by running the waterfall strategies.
 *
 * @param {object} page - Playwright `Page` instance.
 * @param {number} timeout
 * @returns {Promise<object>} Shape: `{ username, password, submit }`. Each
 *   value is a Playwright `Locator` or null. `submit` may be null if no
 *   button is found — the caller should fall back to pressing Enter on the
 *   password field.
 * @private
 */
async function resolveLoginFields(page, timeout) {
  const username = await firstVisible(page, [
    () => page.locator('input[type="email"]'),
    () => page.getByLabel(/e-?mail|user(name)?|login/i),
    () => page.getByPlaceholder(/e-?mail|user(name)?|login/i),
    () => page.getByRole("textbox", { name: /e-?mail|user(name)?|login/i }),
    () => page.locator(
      'input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]'
    ),
    // Last resort: first visible non-password text input.
    () => page.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])'),
  ], timeout);

  const password = await firstVisible(page, [
    () => page.locator('input[type="password"]'),
  ], timeout);

  const submit = await firstVisible(page, [
    () => page.getByRole("button", { name: /sign\s*in|log\s*in|login|submit|continue|next/i }),
    () => page.locator('button[type="submit"], input[type="submit"]'),
    // Any button inside a form that contains a password field.
    () => page.locator('form:has(input[type="password"]) button:not([type="button"])'),
  ], timeout);

  return { username, password, submit };
}

/**
 * Attempt to log in by auto-detecting the login form elements.
 *
 * @param {object} page - Playwright `Page` already navigated to the login URL.
 * @param {object} creds - `{ username, password }` strings.
 * @param {object} [opts]
 * @param {number}   [opts.timeout=5000]   - Per-strategy visibility timeout (ms).
 * @param {Function} [opts.logger]         - Optional logger `(msg) => void`.
 * @returns {Promise<object>} Result envelope `{ ok: boolean, reason?: string }`.
 *   Never throws — transient Playwright errors are captured in `reason`.
 */
export async function performAutoLogin(page, { username, password, totpSecret } = {}, { timeout = 5000, logger } = {}) {
  const log = typeof logger === "function" ? logger : () => {};
  if (!username || !password) {
    return { ok: false, reason: "username and password are required" };
  }

  try {
    const { username: userEl, password: passEl, submit: submitEl } = await resolveLoginFields(page, timeout);

    if (!userEl) return { ok: false, reason: "Could not locate username/email field" };
    if (!passEl) return { ok: false, reason: "Could not locate password field" };

    await userEl.fill(username);
    await passEl.fill(password);

    if (submitEl) {
      await submitEl.click({ timeout });
    } else {
      // No submit button found — pressing Enter submits the form natively
      // in virtually all browsers when the focus is inside a password field
      // that lives inside a <form>.
      log("No submit button found, pressing Enter to submit");
      await passEl.press("Enter");
    }

    // B4 (AUDIT-ROADMAP) / SCL-001 — target-app TOTP. When a `totpSecret`
    // is configured, look for an OTP field on the post-submit page and
    // fill the live RFC 6238 code. The detection waterfall mirrors the
    // industry-standard MFA selectors:
    //   1. autocomplete=one-time-code (HTML spec — Apple Keychain / Chrome
    //      Password Manager autofill use this attribute).
    //   2. aria-label / placeholder containing "code" / "OTP" /
    //      "verification" — heuristic fallback for apps that haven't
    //      adopted the autocomplete attribute.
    // Best-effort: when the TOTP field doesn't appear within the timeout
    // (the app has no MFA, or the user already trusted this device, or
    // a different challenge type was issued) we silently exit. The login
    // is "ok" because username + password completed; the caller's auth
    // recovery path will catch the case where the post-MFA navigation
    // never reaches the dashboard.
    if (totpSecret) {
      const totpResult = await fillTotpField(page, totpSecret, { timeout, logger: log });
      if (totpResult.attempted && !totpResult.ok) {
        return { ok: false, reason: totpResult.reason };
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

// ── B4 / SCL-001 — target-app TOTP support ───────────────────────────────────

/**
 * Locate the post-password OTP field and fill the live RFC 6238 code.
 * Retries once on a 30s-window-boundary rejection.
 *
 * @param {object} page
 * @param {string} totpSecret  - Base32 TOTP seed (already decrypted).
 * @param {object} [opts]
 * @param {number} [opts.timeout=5000]
 * @param {Function} [opts.logger]
 * @returns {Promise<Object>} `{ attempted, ok, reason }`:
 *   - `attempted: false, ok: true` → no OTP field detected within the
 *     discovery timeout (NOT an error — the SUT may not have MFA for
 *     this account, or the user already trusted this device).
 *   - `attempted: true, ok: true` → OTP field found and submitted; the
 *     field disappeared after submit (success).
 *   - `attempted: true, ok: false` → field found but retry exhausted;
 *     caller fails the run with `auth_session_expired_unrecoverable`.
 *     `reason` carries the human-readable diagnostic.
 * @private
 */
async function fillTotpField(page, totpSecret, { timeout = 5000, logger } = {}) {
  const log = typeof logger === "function" ? logger : () => {};
  // Most apps render the OTP step within 1-2s of submit. A long wait
  // here is wasteful on the (common) no-MFA path.
  const discoveryTimeout = Math.min(timeout, 3000);

  const otpField = await firstVisible(page, [
    // Industry-standard autocomplete attribute (HTML spec / Apple
    // Keychain / Chrome Password Manager autofill).
    () => page.locator('input[autocomplete="one-time-code"]'),
    // Aria-label / placeholder / name heuristics for apps without
    // the autocomplete attribute.
    () => page.locator('input[aria-label*="code" i], input[aria-label*="otp" i], input[aria-label*="verification" i]'),
    () => page.locator('input[placeholder*="code" i], input[placeholder*="otp" i], input[placeholder*="verification" i]'),
    () => page.locator('input[name*="otp" i], input[name*="code" i], input[id*="otp" i], input[id*="code" i]'),
  ], discoveryTimeout);

  if (!otpField) return { attempted: false, ok: true };

  for (let attempt = 0; attempt < 2; attempt++) {
    let code;
    try {
      ({ code } = generateTotpCode(totpSecret));
    } catch (genErr) {
      return { attempted: true, ok: false, reason: `TOTP code generation failed: ${genErr?.message || genErr}` };
    }

    try {
      await otpField.fill(code);
    } catch (fillErr) {
      return { attempted: true, ok: false, reason: `TOTP field fill failed: ${fillErr?.message || fillErr}` };
    }

    // Many apps auto-submit on the last digit; for the rest, find a
    // Verify/Submit/Continue button. Pressing Enter is the fallback.
    try {
      const otpSubmit = await firstVisible(page, [
        () => page.getByRole("button", { name: /verify|continue|submit|sign\s*in|log\s*in|next/i }),
        () => page.locator('button[type="submit"], input[type="submit"]'),
      ], 1500);
      if (otpSubmit) {
        await otpSubmit.click({ timeout: 2000 });
      } else {
        await otpField.press("Enter");
      }
    } catch {
      // Non-fatal — auto-submit-on-last-digit may have already
      // navigated away. Fall through to the retry check.
    }

    // OTP field gone → success. Still visible → rejected; retry once.
    //
    // Use `waitFor({ state: "hidden" })` (NOT `isVisible({ timeout })`):
    // Playwright's `isVisible()` ignores its `timeout` option when the
    // element is currently visible and returns `true` synchronously, so
    // the post-submit OTP field — which is by definition still on screen
    // at the instant we check — would always return `true` and force a
    // retry on the happy path. `waitFor({ state: "hidden" })` honours the
    // timeout and resolves when the field disappears (auto-submit /
    // navigation away / DOM swap). On timeout it throws, which we treat
    // as "still on screen" → loop into the retry branch below.
    try {
      await otpField.first().waitFor({ state: "hidden", timeout: 1500 });
      return { attempted: true, ok: true };
    } catch {
      // Still visible after the wait — fall through to the retry branch.
    }

    if (attempt === 0) {
      // Wait for the next 30s window so the retry generates a NEW code.
      // `generateTotpCode` computes the step counter from
      // `Math.floor(Date.now() / 1000 / 30)` — a fixed 1.5s delay only
      // crosses the 30s boundary ~5% of the time (when we happen to be
      // in the last 1.5s of the current window). Use a dynamic wait that
      // reaches the next boundary + 1s margin so the retry is guaranteed
      // to produce a different code.
      const nowSec = Math.floor(Date.now() / 1000);
      const secsUntilNextWindow = 30 - (nowSec % 30) + 1; // +1s margin
      log(`TOTP first attempt did not advance — waiting ${secsUntilNextWindow}s for next window before retry`);
      await page.waitForTimeout(secsUntilNextWindow * 1000).catch(() => {});
    }
  }

  return { attempted: true, ok: false, reason: "TOTP rejected after retry — verify the seed matches the target app's enrollment" };
}

// ── B4 / RLY-004 — mid-run session recovery ──────────────────────────────────

/**
 * Default URL patterns that indicate the SUT redirected an authenticated
 * page to its login flow. Operators can extend via `AUTH_REDIRECT_PATTERNS`
 * env var (JSON-encoded array of regex source strings).
 */
export const DEFAULT_AUTH_REDIRECT_PATTERNS = [
  /\/login(?:[/?#]|$)/i,
  /\/sign[-_]?in(?:[/?#]|$)/i,
  /\/auth(?:[/?#]|$)/i,
  /\/session[-_]?expired/i,
  /\/unauthor(?:ised|ized)/i,
];

function compileExtraAuthRedirectPatterns() {
  const raw = process.env.AUTH_REDIRECT_PATTERNS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((src) => {
        try { return new RegExp(String(src), "i"); }
        catch (err) {
          console.warn(formatLogLine("warn", null, `[autoLogin] Invalid AUTH_REDIRECT_PATTERNS entry "${src}": ${err.message}`));
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[autoLogin] AUTH_REDIRECT_PATTERNS is not valid JSON: ${err.message}`));
    return [];
  }
}

const COMPILED_AUTH_REDIRECT_PATTERNS = [
  ...DEFAULT_AUTH_REDIRECT_PATTERNS,
  ...compileExtraAuthRedirectPatterns(),
];

/**
 * Does this URL look like the SUT's login / session-expired redirect?
 * Called from `executeTest.js` after every `page.goto()` and after every
 * full healing-strategy exhaustion to decide whether to trigger
 * `restoreAuthSession`.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function looksLikeAuthRedirect(url) {
  if (typeof url !== "string" || !url) return false;
  return COMPILED_AUTH_REDIRECT_PATTERNS.some((re) => re.test(url));
}

/**
 * Restore an expired session mid-run. Decrypts the project's credentials,
 * captures the originating URL, navigates to `project.url`, re-runs
 * `performAutoLogin` (with TOTP transparently), then navigates back.
 * Never throws.
 *
 * @param {object} page
 * @param {object} project - Project row (with encrypted credentials).
 * @param {object} [opts]
 * @param {object} [opts.run]  - Run object for structured logging context.
 * @param {Function} [opts.logger]
 * @returns {Promise<Object>} `{ ok, reason, restoredFromUrl, returnedToUrl }`:
 *   - `ok: true` → re-login succeeded. `restoredFromUrl` is the URL the
 *     test was on before the redirect; `returnedToUrl` is where the page
 *     ended up (either the original URL on a clean recover, or
 *     `project.url` if back-navigation also failed).
 *   - `ok: false` → recovery aborted. `reason` is one of
 *     `no_credentials_configured`, `no_project_url`,
 *     `credentials_decryption_failed` (AES round-trip failed — key
 *     rotated or blob corrupt), `credentials_blank` (decrypt OK but
 *     username + password both empty), `recovery_navigation_failed: …`,
 *     or `relogin_failed: …`. Caller surfaces as `auth_expired` skip.
 */
export async function restoreAuthSession(page, project, opts = {}) {
  const { run, logger } = opts;
  const log = typeof logger === "function"
    ? logger
    : (msg) => {
        try { console.log(formatLogLine("info", run?.id || null, `[autoLogin] ${msg}`)); } catch { /* best-effort */ }
      };

  if (!project?.credentials) {
    return { ok: false, reason: "no_credentials_configured" };
  }
  if (!project?.url) {
    return { ok: false, reason: "no_project_url" };
  }

  // Split the legacy `credentials_decryption_failed` envelope into two
  // distinct reasons so operators get an actionable diagnostic:
  //   - `credentials_decryption_failed` — `decryptCredentials` returned
  //     `null` (key rotation without re-encrypt, corrupt AES blob).
  //     Fix path: re-encrypt the project's credentials with the current
  //     `CREDENTIAL_SECRET`.
  //   - `credentials_blank` — decrypt succeeded but both username and
  //     password are empty strings. Fix path: set the credentials on
  //     the project (they were never configured, or were cleared).
  // Pre-split, both surfaced as `credentials_decryption_failed`, sending
  // operators chasing a decryption issue when the real cause was empty
  // fields. Both reasons remain in the `NON_EXECUTED_SKIP_REASONS` /
  // `AUTH_EXPIRED` classifier paths so accounting is unchanged.
  const creds = decryptCredentials(project.credentials);
  if (!creds) {
    return { ok: false, reason: "credentials_decryption_failed" };
  }
  if (!creds.username && !creds.password) {
    return { ok: false, reason: "credentials_blank" };
  }

  let originatingUrl = "";
  try { originatingUrl = page.url(); } catch { /* page may be closing */ }
  const skipBackNavigation = !originatingUrl
    || originatingUrl === "about:blank"
    || originatingUrl === project.url;

  log(`Session expired — attempting recovery (originatingUrl=${originatingUrl || "<unknown>"})`);

  try {
    await page.goto(project.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (navErr) {
    return { ok: false, reason: `recovery_navigation_failed: ${navErr?.message || navErr}` };
  }

  const loginResult = await performAutoLogin(page, creds, { timeout: 5000, logger: log });
  if (!loginResult.ok) {
    return { ok: false, reason: `relogin_failed: ${loginResult.reason || "unknown"}` };
  }

  if (skipBackNavigation) {
    return { ok: true, restoredFromUrl: originatingUrl || null, returnedToUrl: project.url };
  }

  try {
    await page.goto(originatingUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (backErr) {
    // Login succeeded but back-navigation failed — surface partial
    // success. `ok: true` because the session itself was restored; the
    // caller's next action will re-navigate as needed.
    return {
      ok: true,
      reason: `back_navigation_failed: ${backErr?.message || backErr}`,
      restoredFromUrl: originatingUrl,
      returnedToUrl: project.url,
    };
  }

  log(`Session recovery succeeded — returned to ${originatingUrl}`);
  return { ok: true, restoredFromUrl: originatingUrl, returnedToUrl: originatingUrl };
}
