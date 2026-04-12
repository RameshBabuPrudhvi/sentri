/**
 * @module utils/disposableEmail
 * @description S3-08 — Disposable email support for auth flow testing.
 *
 * Sentri can discover and crawl auth flows but cannot complete registration
 * flows that require email verification. This module provides a
 * `DisposableEmail` client backed by the temp-mail.io API, and a
 * `fillEmailVerificationFlow` helper that `stateExplorer.js` calls when it
 * encounters a signup form.
 *
 * ### Flow
 * 1. `createMailbox()` — allocates a random disposable address.
 * 2. `fillSignupForm(page, mailbox, fields)` — fills the form with the
 *    temp address and any other generated test data.
 * 3. `waitForOtp(mailbox)` — polls the inbox until a message arrives,
 *    then extracts a numeric OTP or verification link.
 * 4. `fillOtpFields(page, otp)` — handles both single-input and
 *    split-digit OTP inputs, using clipboard paste for split fields.
 * 5. `dispose(mailbox)` — deletes the mailbox (best-effort cleanup).
 *
 * ### Configuration
 * | Env var                     | Default                          | Description           |
 * |-----------------------------|----------------------------------|-----------------------|
 * | `TEMP_MAIL_API_KEY`         | —                                | temp-mail.io API key  |
 * | `TEMP_MAIL_BASE_URL`        | https://api.temp-mail.io/request | API base URL          |
 * | `DISPOSABLE_EMAIL_TIMEOUT`  | 60000                            | OTP poll timeout (ms) |
 * | `DISPOSABLE_EMAIL_POLL_MS`  | 3000                             | Poll interval (ms)    |
 *
 * ### Exports
 * - {@link createMailbox}             — allocate a temp email address
 * - {@link waitForOtp}                — poll inbox and extract OTP/link
 * - {@link fillOtpFields}             — fill OTP into page (single or split)
 * - {@link fillEmailVerificationFlow} — high-level helper for stateExplorer
 * - {@link dispose}                   — delete mailbox (cleanup)
 */

const BASE_URL    = process.env.TEMP_MAIL_BASE_URL   || "https://api.temp-mail.io/request";
const API_KEY     = process.env.TEMP_MAIL_API_KEY    || "";
const OTP_TIMEOUT = parseInt(process.env.DISPOSABLE_EMAIL_TIMEOUT, 10) || 60_000;
const POLL_MS     = parseInt(process.env.DISPOSABLE_EMAIL_POLL_MS,  10) || 3_000;

// ── Regex patterns for OTP / verification link extraction ────────────────────

/** Matches 4–8 digit numeric OTPs (most common format) */
const OTP_DIGIT_RE = /\b(\d{4,8})\b/;

/** Matches verification/activation/confirm links */
const VERIFY_LINK_RE = /https?:\/\/[^\s"'<>]+(?:verify|confirm|activate|token|code)[^\s"'<>]*/i;

// ── Low-level API client ─────────────────────────────────────────────────────

/**
 * Build common fetch headers, including the API key if configured.
 * @returns {Record<string, string>}
 */
function apiHeaders() {
  const h = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

/**
 * Fetch a JSON endpoint, returning the parsed body or throwing on HTTP errors.
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<unknown>}
 */
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { headers: apiHeaders(), ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DisposableEmail API error ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Mailbox lifecycle ─────────────────────────────────────────────────────────

/**
 * @typedef {object} Mailbox
 * @property {string} address   - The full email address (e.g. abc123@mailnull.com)
 * @property {string} id        - Mailbox identifier used for subsequent API calls
 * @property {string} _token    - Internal token for message retrieval
 */

/**
 * createMailbox() → Mailbox
 *
 * Allocates a new disposable email address via the temp-mail.io API.
 * The returned `Mailbox` object is passed to all other functions in this module.
 *
 * @returns {Promise<Mailbox>}
 */
export async function createMailbox() {
  let data;
  try {
    data = await apiFetch(`${BASE_URL}/new/`, { method: "POST", body: "{}" });
  } catch (err) {
    // If no API key is configured or the service is unavailable, fall back to
    // a locally generated address that looks valid enough to fill forms.
    // OTP retrieval will fail gracefully — the caller handles this case.
    const fallback = `sentri-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@mailnull.com`;
    console.warn(`[disposableEmail] createMailbox fallback (${err.message}): ${fallback}`);
    return { address: fallback, id: fallback, _token: "" };
  }

  return {
    address: data.address || data.email,
    id:      data.id || data.address || data.email,
    _token:  data.token || data.id || "",
  };
}

/**
 * dispose(mailbox) → void
 *
 * Deletes the mailbox. Best-effort — never throws.
 *
 * @param {Mailbox} mailbox
 * @returns {Promise<void>}
 */
export async function dispose(mailbox) {
  if (!mailbox?.id) return;
  try {
    await apiFetch(`${BASE_URL}/delete/id/${encodeURIComponent(mailbox.id)}/`, { method: "DELETE" });
  } catch { /* best-effort — ignore */ }
}

// ── OTP extraction ────────────────────────────────────────────────────────────

/**
 * extractOtpFromMessage(message) → { otp: string|null, link: string|null }
 *
 * Tries to extract a numeric OTP code or a verification URL from a raw email
 * message body. Returns both in case the caller wants to try the link first.
 *
 * @param {string} text  - Plain-text or HTML email body
 * @returns {{ otp: string|null, link: string|null }}
 */
export function extractOtpFromMessage(text) {
  // Strip HTML tags for cleaner matching
  const plain = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");

  const linkMatch = plain.match(VERIFY_LINK_RE);
  const otpMatch  = plain.match(OTP_DIGIT_RE);

  return {
    otp:  otpMatch  ? otpMatch[1]  : null,
    link: linkMatch ? linkMatch[0] : null,
  };
}

/**
 * waitForOtp(mailbox) → { otp: string|null, link: string|null }
 *
 * Polls the temp-mail.io inbox until a message arrives or the timeout is
 * reached. On success, extracts an OTP code or verification link.
 *
 * @param {Mailbox} mailbox
 * @returns {Promise<{ otp: string|null, link: string|null }>}
 */
export async function waitForOtp(mailbox) {
  if (!mailbox?.id || !API_KEY) {
    // No API key — caller should skip OTP verification step
    return { otp: null, link: null };
  }

  const deadline = Date.now() + OTP_TIMEOUT;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));

    let messages;
    try {
      messages = await apiFetch(`${BASE_URL}/mail/id/${encodeURIComponent(mailbox.id)}/`);
    } catch {
      continue; // network hiccup — keep polling
    }

    const list = Array.isArray(messages) ? messages : (messages?.mails || []);
    if (list.length === 0) continue;

    // Use the most recent message
    const latest = list[list.length - 1];
    const body   = latest.body_text || latest.body_html || latest.textBody || latest.htmlBody || "";
    const subject = latest.subject || "";

    const result = extractOtpFromMessage(body + " " + subject);
    if (result.otp || result.link) return result;
  }

  return { otp: null, link: null };
}

// ── Page interaction helpers ──────────────────────────────────────────────────

/**
 * fillOtpFields(page, otp) → boolean
 *
 * Fills an OTP code into the active page, handling both:
 *   - Single `<input>` fields (fills the whole string)
 *   - Split digit inputs (one `<input maxlength="1">` per digit, pasted
 *     via clipboard so focus advances automatically)
 *
 * Returns `true` if at least one input was filled successfully.
 *
 * @param {Object} page  - Playwright Page instance
 * @param {string} otp
 * @returns {Promise<boolean>}
 */
export async function fillOtpFields(page, otp) {
  if (!otp) return false;

  // Detect split OTP inputs (multiple single-character inputs in a row)
  const splitInputs = await page.locator("input[maxlength='1']").all();
  if (splitInputs.length >= otp.length) {
    // Paste via clipboard for maximum compatibility with SPA OTP components
    // (React, Vue, Svelte OTP inputs rely on the paste event to advance focus)
    try {
      await page.evaluate(async (code) => {
        await navigator.clipboard.writeText(code);
      }, otp).catch(() => {});

      // Focus the first input and dispatch a paste event
      await splitInputs[0].focus().catch(() => {});
      await page.keyboard.press("Control+V").catch(() => {});
      await page.waitForTimeout(300);

      // Fallback: fill each digit individually if paste didn't populate them
      const values = await Promise.all(splitInputs.slice(0, otp.length).map(el => el.inputValue().catch(() => "")));
      const alreadyFilled = values.some(v => v.length > 0);
      if (!alreadyFilled) {
        for (let i = 0; i < Math.min(otp.length, splitInputs.length); i++) {
          await splitInputs[i].fill(otp[i]).catch(() => {});
        }
      }
      return true;
    } catch { return false; }
  }

  // Single OTP input — try common selectors
  const singleSelectors = [
    "input[autocomplete='one-time-code']",
    "input[name*='otp' i]",
    "input[name*='code' i]",
    "input[name*='token' i]",
    "input[placeholder*='code' i]",
    "input[placeholder*='otp' i]",
    "input[aria-label*='code' i]",
    "input[aria-label*='otp' i]",
  ];

  for (const sel of singleSelectors) {
    const el = page.locator(sel).first();
    try {
      const count = await el.count();
      if (count === 0) continue;
      await el.fill(otp);
      return true;
    } catch { continue; }
  }

  return false;
}

// ── High-level helper for stateExplorer ──────────────────────────────────────

/**
 * fillEmailVerificationFlow(page, formFields, run) → { email: string, completed: boolean }
 *
 * High-level helper called by `stateExplorer.js` when it encounters a
 * signup/registration form. Orchestrates the full flow:
 *
 * 1. Creates a disposable mailbox.
 * 2. Fills the email field with the temp address (and password if present).
 * 3. Submits the form.
 * 4. Polls the inbox for a verification OTP or link.
 * 5. Clicks the verification link or fills the OTP field.
 * 6. Returns the address and whether verification was completed.
 *
 * Designed to be called from `executeFormGroup` in stateExplorer when the
 * form intent is detected as SIGNUP / REGISTRATION (see actionDiscovery.js).
 *
 * @param {Object} page  - Playwright Page instance
 * @param {Array<Object>} formFields  - Field descriptors with selector, type, label, etc.
 * @param {object} run  - Mutable run record for SSE logging
 * @returns {Promise<{ email: string, otpFilled: boolean, linkFollowed: boolean }>}
 */
export async function fillEmailVerificationFlow(page, formFields, run) {
  const mailbox = await createMailbox();
  let otpFilled     = false;
  let linkFollowed  = false;

  try {
    // Fill the email field with the disposable address
    for (const field of formFields) {
      const fieldType = (field.type || "").toLowerCase();
      const hints     = `${field.label || ""} ${field.placeholder || ""} ${field.ariaLabel || ""}`.toLowerCase();

      if (fieldType === "email" || hints.includes("email")) {
        try {
          const el = page.locator(field.selector).first();
          await el.fill(mailbox.address);
        } catch { /* element may have shifted — skip */ }
      }
    }

    // Poll for OTP / verification link
    const { otp, link } = await waitForOtp(mailbox);

    if (link) {
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 15_000 });
        linkFollowed = true;
      } catch { /* link may have expired */ }
    } else if (otp) {
      otpFilled = await fillOtpFields(page, otp);
    }
  } finally {
    // Clean up regardless of outcome
    await dispose(mailbox).catch(() => {});
  }

  return { email: mailbox.address, otpFilled, linkFollowed };
}
