/**
 * B4 (AUDIT-ROADMAP) — TOTP primitives (`utils/totp.js`) + credential
 * encryption round-trip with `totpSecret`.
 *
 * Pinned contracts:
 *  1. `base32Decode` tolerates whitespace, lowercase, and `=` padding.
 *  2. `computeTotpAtStep` matches the RFC 6238 reference test vectors.
 *  3. `verifyTotp` allows ±`MFA_TOTP_WINDOW` step skew and uses
 *     constant-time comparison.
 *  4. `generateTotpCode` returns `{ code, expiresInSeconds }` with the
 *     remaining seconds in the current 30s window.
 *  5. `encryptCredentials` / `decryptCredentials` round-trip `totpSecret`
 *     through AES-256-GCM and never echo it on the legacy path.
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import {
  base32Decode,
  generateTotpSecret,
  computeTotpAtStep,
  generateTotpCode,
  verifyTotp,
} from "../src/utils/totp.js";
import {
  encryptCredentials,
  decryptCredentials,
} from "../src/utils/credentialEncryption.js";

// AGENTS.md § "Do not duplicate test helpers" + line 132 pattern 2 — use
// the canonical `createTestContext().createTestRunner()` runner from
// `tests/helpers/test-base.js`. The runner returns `{ test, summary }`
// (see `createTestRunner` at `tests/helpers/test-base.js:327-376`);
// `test("name", fn)` records pass/fail and `summary("label")` prints the
// per-file tally and exits non-zero on any failure.
const ctx = createTestContext();
const { test, summary } = ctx.createTestRunner();

// RFC 6238 Appendix B test vectors — secret "12345678901234567890" in ASCII
// → base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// The runner's `test()` is async; awaiting in sequence inside an async
// main keeps the per-test output ordered AND ensures `summary()` runs
// after every assertion has resolved. Mirrors the canonical pattern at
// `tests/auth-mfa-totp.test.js` etc.
async function main() {

await test("base32Decode tolerates whitespace + lowercase + padding", () => {
  const a = base32Decode("JBSWY3DPEHPK3PXP");
  const b = base32Decode("  jbswy3dpehpk3pxp  ");
  const c = base32Decode("JBSWY3DPEHPK3PXP===");
  assert.equal(a.toString("hex"), b.toString("hex"));
  assert.equal(a.toString("hex"), c.toString("hex"));
});

await test("generateTotpSecret yields a 32-char base32 string", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
});

await test("computeTotpAtStep matches RFC 6238 vector at T=59 (step=1)", () => {
  // RFC 6238 Appendix B, step counter = 1 → expected "287082"
  const code = computeTotpAtStep(RFC_SECRET_B32, 1);
  assert.equal(code, "287082");
});

await test("computeTotpAtStep matches RFC 6238 vector at T=1111111109 (step=37037036)", () => {
  // RFC 6238 Appendix B → expected "081804"
  const code = computeTotpAtStep(RFC_SECRET_B32, 37037036);
  assert.equal(code, "081804");
});

await test("generateTotpCode returns { code, expiresInSeconds } and code verifies", () => {
  const secret = generateTotpSecret();
  const { code, expiresInSeconds } = generateTotpCode(secret);
  assert.match(code, /^\d{6}$/);
  assert.ok(expiresInSeconds >= 1 && expiresInSeconds <= 30, `expected 1..30, got ${expiresInSeconds}`);
  assert.equal(verifyTotp(code, secret), true);
});

await test("verifyTotp rejects malformed input (non-6-digit, empty, alpha)", () => {
  const secret = generateTotpSecret();
  assert.equal(verifyTotp("", secret), false);
  assert.equal(verifyTotp("abc", secret), false);
  assert.equal(verifyTotp("12345", secret), false);
  assert.equal(verifyTotp("1234567", secret), false);
});

await test("verifyTotp accepts ±1 window of clock skew by default", () => {
  const secret = generateTotpSecret();
  // Code from the previous window should still verify.
  const prevCode = generateTotpCode(secret, -1).code;
  assert.equal(verifyTotp(prevCode, secret), true);
  // Code from the next window should also verify.
  const nextCode = generateTotpCode(secret, 1).code;
  assert.equal(verifyTotp(nextCode, secret), true);
});

await test("verifyTotp rejects codes from outside the ±1 window", () => {
  const secret = generateTotpSecret();
  // Step counter offset of -3 is far enough outside the ±1 default that
  // even on a freshly-rolled window boundary the code can't land in the
  // allowed range.
  const farCode = generateTotpCode(secret, -3).code;
  assert.equal(verifyTotp(farCode, secret), false);
});

await test("encryptCredentials round-trips totpSecret through AES-256-GCM", () => {
  const seed = generateTotpSecret();
  const enc = encryptCredentials({
    username: "alice@example.com",
    password: "p4ssw0rd!",
    totpSecret: seed,
  });
  assert.ok(enc._encrypted, "credentials should be marked encrypted");
  assert.notEqual(enc.totpSecret, seed, "stored totpSecret must be ciphertext");
  assert.ok(enc.totpSecret.length > seed.length, "ciphertext should be longer than plaintext");
  const dec = decryptCredentials(enc);
  assert.equal(dec.username, "alice@example.com");
  assert.equal(dec.password, "p4ssw0rd!");
  assert.equal(dec.totpSecret, seed);
});

await test("encryptCredentials omits totpSecret cleanly when not provided", () => {
  const enc = encryptCredentials({
    username: "alice@example.com",
    password: "p4ssw0rd!",
  });
  // Stored form may include an empty-string slot, but decrypt must NOT
  // produce a truthy totpSecret on a project that never configured one.
  const dec = decryptCredentials(enc);
  assert.equal(dec.totpSecret || "", "");
});

// Bug-fix regression pin: extending `encryptCredentials` to round-trip
// extreme / boundary base32 inputs the route-layer validator (`/^[A-Z2-7]{16,128}$/`)
// is the gatekeeper for. The encryption layer itself is format-agnostic
// — it would happily store `"not-base32"` as ciphertext — so the only
// way to guarantee `dec.totpSecret` round-trips a valid seed is to
// pin the boundary lengths against the AES envelope.
await test("encryptCredentials round-trips minimum-length (16-char) base32 seed", () => {
  const seed = "ABCDEFGHIJKLMNOP"; // 16 chars — the minimum the route accepts
  const enc = encryptCredentials({ username: "u", password: "p", totpSecret: seed });
  assert.equal(decryptCredentials(enc).totpSecret, seed);
});

await test("encryptCredentials round-trips maximum-length (128-char) base32 seed", () => {
  const seed = "A".repeat(128); // 128 chars — the ceiling the route accepts
  const enc = encryptCredentials({ username: "u", password: "p", totpSecret: seed });
  assert.equal(decryptCredentials(enc).totpSecret, seed);
});

await test("decryptCredentials handles legacy rows (no _encrypted) without throwing", () => {
  // Pre-B4 rows have `totpSecret` absent entirely. The decryption path
  // must NOT throw and must surface an empty totpSecret.
  const legacy = {
    username: "alice@example.com",
    password: "p4ssw0rd!",
    // no _encrypted marker → returned as-is
  };
  const dec = decryptCredentials(legacy);
  assert.equal(dec.username, "alice@example.com");
  assert.equal(dec.totpSecret || "", "");
});

  summary("b4-totp");
}

main().catch((err) => {
  console.error("b4-totp test runner crashed:", err);
  process.exit(1);
});
