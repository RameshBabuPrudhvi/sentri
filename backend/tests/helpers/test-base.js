/**
 * @module tests/helpers/test-base
 * @description Shared test utilities for backend integration tests.
 *
 * Centralises the duplicated patterns across integration test files:
 * - HTTP request helpers with automatic CSRF handling
 * - Cookie extraction
 * - Database reset
 * - User registration + login (with email verification bypass)
 * - JWT payload decoding
 * - Environment variable save/restore
 * - Mini test runner with pass/fail counting
 *
 * ### Usage
 * ```js
 * import { createTestContext } from "./helpers/test-base.js";
 *
 * const t = createTestContext();
 *
 * async function main() {
 *   t.resetDb();
 *   const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
 *   const server = t.app.listen(0);
 *   const base = `http://127.0.0.1:${server.address().port}`;
 *   try {
 *     const { token } = await t.registerAndLogin(base, {
 *       name: "Test User", email: "test@example.com", password: "Password123!",
 *     });
 *     // ... test logic using t.req(), t.extractCookie(), etc.
 *   } finally {
 *     env.restore();
 *     await new Promise(r => server.close(r));
 *   }
 * }
 * ```
 */

import assert from "node:assert/strict";
import { app } from "../../src/middleware/appSetup.js";
import { getDatabase } from "../../src/database/sqlite.js";
import { workspaceScope } from "../../src/middleware/workspaceScope.js";

// ─── Cookie helpers ───────────────────────────────────────────────────────────

/**
 * Extract a named cookie value from a fetch Response's Set-Cookie header.
 *
 * @param {Response} res — fetch Response object.
 * @param {string}   name — Cookie name (e.g. "access_token", "_csrf").
 * @returns {string|null} Cookie value, or null if not found.
 */
export function extractCookie(res, name) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const match = c.match(new RegExp(`^${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

/**
 * Parse all Set-Cookie headers into a map of `{ name → { value, attrs } }`.
 *
 * @param {Response} res — fetch Response object.
 * @returns {Object<string, { value: string, attrs: string[] }>}
 */
export function parseCookies(res) {
  const raw = res.headers.getSetCookie?.() || [];
  const cookies = {};
  for (const c of raw) {
    const parts = c.split(";").map(s => s.trim());
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf("=");
    const name = nameVal.slice(0, eqIdx);
    const value = nameVal.slice(eqIdx + 1);
    cookies[name] = { value, attrs: attrs.map(a => a.toLowerCase()) };
  }
  return cookies;
}

/**
 * Build a Cookie header string from a parsed cookies map.
 *
 * @param {Object<string, { value: string }>} cookies
 * @returns {string}
 */
export function buildCookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v.value || v}`).join("; ");
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

/**
 * Decode a JWT payload without signature verification (base64url decode).
 *
 * @param {string} token — JWT string.
 * @returns {Object} Decoded payload.
 */
export function decodeJwtPayload(token) {
  const parts = token.split(".");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString());
}

// ─── Database helpers ─────────────────────────────────────────────────────────

/**
 * Tables to clear during resetDb(), in dependency-safe order.
 * Additional tables can be passed to resetDb() for test-specific cleanup.
 */
const RESET_TABLES = [
  "verification_tokens",
  "password_reset_tokens",
  "webhook_tokens",
  "schedules",
  "run_logs",
  "healing_history",
  "activities",
  "runs",
  "tests",
  "oauth_ids",
  "projects",
  "workspace_members",
  "workspaces",
  "users",
];

/**
 * Clear all data from the database and reset counters.
 * Safe to call multiple times — uses DELETE (not DROP) so schema is preserved.
 *
 * @param {string[]} [extraTables] — Additional table names to clear first.
 */
export function resetDb(extraTables = []) {
  const db = getDatabase();
  for (const table of extraTables) {
    try { db.exec(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
  for (const table of RESET_TABLES) {
    try { db.exec(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
  db.exec("UPDATE counters SET value = 0");
}

// ─── Environment helpers ──────────────────────────────────────────────────────

/**
 * Set environment variables and return a restore function.
 * Handles undefined (delete) vs string (set) correctly.
 *
 * @param {Object<string, string>} vars — `{ VAR_NAME: "value" }`.
 * @returns {{ restore: () => void }} Call `.restore()` in a finally block.
 */
export function setupEnv(vars) {
  const originals = {};
  for (const [key, value] of Object.entries(vars)) {
    originals[key] = process.env[key];
    process.env[key] = value;
  }
  return {
    restore() {
      for (const [key, orig] of Object.entries(originals)) {
        if (orig === undefined) delete process.env[key];
        else process.env[key] = orig;
      }
    },
  };
}

// ─── HTTP request helpers ─────────────────────────────────────────────────────

/**
 * Create a stateful HTTP request helper that tracks CSRF tokens.
 *
 * The returned `req()` function automatically:
 * - Sends `Content-Type: application/json`
 * - Attaches the Bearer token (if provided)
 * - Sends the CSRF double-submit cookie + header (if captured)
 * - Captures CSRF cookies from responses
 * - Parses JSON response bodies
 *
 * @returns {{ req: Function, extractCookie: Function, csrfToken: string|null }}
 */
export function createRequestHelper() {
  let csrfToken = null;

  /**
   * Make an HTTP request with automatic CSRF handling.
   *
   * @param {string} base — Base URL (e.g. "http://127.0.0.1:3001").
   * @param {string} path — Request path (e.g. "/api/auth/login").
   * @param {Object} [opts]
   * @param {string} [opts.method="GET"]
   * @param {string} [opts.token] — Bearer token for Authorization header.
   * @param {string} [opts.cookie] — Raw Cookie header value (overrides token).
   * @param {Object} [opts.body] — JSON body (auto-serialized).
   * @returns {Promise<{ res: Response, json: Object }>}
   */
  async function req(base, path, { method = "GET", token, cookie, body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    if (csrfToken) {
      headers["X-CSRF-Token"] = csrfToken;
      headers.Cookie = (headers.Cookie ? headers.Cookie + "; " : "") + `_csrf=${csrfToken}`;
    }
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const csrf = extractCookie(res, "_csrf");
    if (csrf) csrfToken = csrf;
    const json = await res.json().catch(() => ({}));
    return { res, json };
  }

  return { req, extractCookie, get csrfToken() { return csrfToken; } };
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Register a user and log them in, returning the auth token.
 *
 * Handles both `SKIP_EMAIL_VERIFICATION` mode (auto-verified) and
 * manual DB verification (when skip is not set).
 *
 * @param {Function} req — Request helper from `createRequestHelper()`.
 * @param {string}   base — Base URL.
 * @param {Object}   opts
 * @param {string}   opts.name
 * @param {string}   opts.email
 * @param {string}   opts.password
 * @returns {Promise<{ token: string, userId: string }>}
 */
export async function registerAndLogin(req, base, { name, email, password }) {
  // Register
  let out = await req(base, "/api/auth/register", {
    method: "POST",
    body: { name, email, password },
  });
  assert.equal(out.res.status, 201, `Registration failed: ${out.json.error || out.res.status}`);

  // If SKIP_EMAIL_VERIFICATION is not set, verify via direct DB update
  if (process.env.SKIP_EMAIL_VERIFICATION !== "true") {
    const db = getDatabase();
    db.prepare("UPDATE users SET emailVerified = 1 WHERE email = ?").run(email);
  }

  // Login
  out = await req(base, "/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(out.res.status, 200, `Login failed: ${out.json.error || out.res.status}`);
  const token = extractCookie(out.res, "access_token");
  assert.ok(token, "Login should set access_token cookie");

  // Decode user ID from token
  const payload = decodeJwtPayload(token);

  return { token, userId: payload.sub, payload };
}

// ─── Mini test runner ─────────────────────────────────────────────────────────

/**
 * Create a mini test runner with pass/fail counting.
 *
 * @returns {{ test: Function, summary: Function, passed: number, failed: number }}
 */
export function createTestRunner() {
  let passed = 0;
  let failed = 0;

  /**
   * Run a named test function and track pass/fail.
   *
   * @param {string}   name — Test description.
   * @param {Function} fn — Async test function (should throw on failure).
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`  ✅  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ❌  ${name}`);
      console.log(`      ${err.message}`);
    }
  }

  /**
   * Print summary and exit with code 1 if any tests failed.
   *
   * @param {string} [label] — Optional label for the summary line.
   */
  function summary(label) {
    console.log(`\n  ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    if (label) console.log(`\n🎉 All ${label} tests passed!`);
  }

  return {
    test,
    summary,
    get passed() { return passed; },
    get failed() { return failed; },
  };
}

// ─── Convenience: full test context ───────────────────────────────────────────

/**
 * Create a full test context with all helpers pre-wired.
 *
 * This is the recommended entry point for integration tests.
 *
 * @returns {Object} Context with `app`, `req`, `extractCookie`, `parseCookies`,
 *   `buildCookieHeader`, `decodeJwtPayload`, `resetDb`, `setupEnv`,
 *   `registerAndLogin`, `createTestRunner`, `getDatabase`.
 */
export function createTestContext() {
  const { req, extractCookie: ec } = createRequestHelper();

  return {
    app,
    getDatabase,
    workspaceScope,
    req,
    extractCookie: ec,
    parseCookies,
    buildCookieHeader,
    decodeJwtPayload,
    resetDb,
    setupEnv,
    createTestRunner,

    /**
     * Register + login shorthand bound to the internal req helper.
     *
     * @param {string} base
     * @param {Object} opts — `{ name, email, password }`
     * @returns {Promise<{ token: string, userId: string, payload: Object }>}
     */
    registerAndLogin: (base, opts) => registerAndLogin(req, base, opts),
  };
}
