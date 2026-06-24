/**
 * @module utils/totp
 * @description RFC 6238 TOTP primitives — base32 decode + HMAC-SHA1 step
 * computation + verify-with-window — extracted from `routes/auth.js` so
 * both Sentri's own MFA flow (SEC-004) AND the target-application login
 * helper (SCL-001 / Bundle 4 — `pipeline/autoLogin.js`) share a single
 * implementation.
 *
 * ### Why one module
 * - **Algorithm drift safety.** SEC-004's audit, recovery-code tests, and
 *   E2E suite all pin on `_internalGenerateTotpCode`'s output. If the
 *   target-app branch grew its own implementation (or pulled in
 *   `@otpauth/totp`) the two paths could silently diverge — e.g. one
 *   issues 6-digit SHA-1 codes, the other 8-digit SHA-256 — and the
 *   regression would be invisible until a customer's authenticator app
 *   stopped working.
 * - **No new dependency.** Adding `@otpauth/totp` (or `otplib`) for ~50
 *   lines of well-tested HMAC-SHA1 logic violates AGENTS.md
 *   "Do not add large dependencies without justification". The repo
 *   already ships this primitive — extract, don't add.
 *
 * ### Industry-standard defaults
 * 30-second period, 6-digit code, SHA-1 — matches Google Authenticator,
 * Authy, 1Password, and the RFC 6238 reference. Operators configuring
 * their target app's MFA seed should select these defaults; alternative
 * digest lengths / algorithms are out of scope for B4.
 *
 * Constant-time verification: `verifyTotp` iterates every candidate
 * window even after a match and uses `crypto.timingSafeEqual` so total
 * runtime does not leak which window (or whether any) matched.
 */

import crypto from "crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode a base32-encoded TOTP secret to its raw byte buffer (RFC 4648).
 * Tolerant of whitespace, lowercase, and trailing `=` padding.
 *
 * @param {string} input
 * @returns {Buffer}
 */
export function base32Decode(input) {
  const clean = String(input || "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    out.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(out);
}

/**
 * Generate a fresh 160-bit (32-char base32) TOTP secret. Matches RFC 6238 /
 * Google Authenticator defaults so any standard authenticator app interops.
 * @returns {string}
 */
export function generateTotpSecret() {
  const bytes = crypto.randomBytes(20);
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Compute the RFC 6238 TOTP code for a given base32 secret at a given step
 * counter. Single source of truth for both the production `verifyTotp` loop
 * and the test helper / target-app fill helper.
 *
 * @param {string} secret      - Base32 TOTP secret.
 * @param {number} stepCounter - 30-second step counter (`floor(unixSeconds / 30)`).
 * @returns {string} Zero-padded 6-digit code.
 */
export function computeTotpAtStep(secret, stepCounter) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(stepCounter));
  const hmac = crypto.createHmac("sha1", key).update(counter).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[off] & 0x7f) << 24) |
    ((hmac[off + 1] & 0xff) << 16) |
    ((hmac[off + 2] & 0xff) << 8) |
    (hmac[off + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/**
 * Generate the TOTP code valid right now (or at a given step offset).
 *
 * Returns `{ code, expiresInSeconds }` so callers (e.g. the operator-
 * facing "Test TOTP" preview endpoint) can render a countdown without
 * recomputing the period boundary themselves. `expiresInSeconds` is the
 * remaining time within the current 30-second window — clamped to [1, 30]
 * so a UI countdown never flashes "0s left" while still showing the code.
 *
 * @param {string} secret           - Base32 TOTP secret.
 * @param {number} [offsetSteps=0]  - Step offset from `now` (clock-skew tests).
 * @returns {{ code: string, expiresInSeconds: number }}
 */
export function generateTotpCode(secret, offsetSteps = 0) {
  const step = 30;
  const nowSec = Math.floor(Date.now() / 1000);
  const stepCounter = Math.floor(nowSec / step) + offsetSteps;
  const code = computeTotpAtStep(secret, stepCounter);
  // Remaining seconds in the current 30s window. Clamped to [1, 30] so a
  // freshly-rolled boundary never reports 0 (the new code is already
  // valid) — UX nicety; the underlying RFC is forgiving on the edge.
  const remaining = step - (nowSec % step);
  const expiresInSeconds = Math.min(step, Math.max(1, remaining));
  return { code, expiresInSeconds };
}

/**
 * Verify a 6-digit TOTP code against a base32 secret. Allows ±`window` steps
 * (default 30s each) of clock skew either side of `now`. Configurable via the
 * `MFA_TOTP_WINDOW` env var (default 1 = ±30s tolerance).
 *
 * Constant-time: iterates every candidate window even after a match and uses
 * `crypto.timingSafeEqual` for the digit comparison so total runtime does not
 * leak which window (or whether any) matched.
 *
 * @param {string} token  - User-supplied 6-digit code.
 * @param {string} secret - Base32 TOTP secret.
 * @param {number} [window]
 * @returns {boolean}
 */
export function verifyTotp(token, secret, window) {
  const w = Number.isFinite(window)
    ? window
    : (parseInt(process.env.MFA_TOTP_WINDOW ?? "1", 10) || 1);
  const t = String(token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(t)) return false;
  const step = 30;
  const now = Math.floor(Date.now() / 1000 / step);
  const tBuf = Buffer.from(t);
  let matched = false;
  for (let i = -w; i <= w; i++) {
    const computed = computeTotpAtStep(secret, now + i);
    try {
      if (crypto.timingSafeEqual(Buffer.from(computed), tBuf)) matched = true;
    } catch {
      /* length mismatch — t validated as /^\d{6}$/ above so unreachable */
    }
  }
  return matched;
}
