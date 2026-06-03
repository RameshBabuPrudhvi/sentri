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
import { _internalGenerateTotpCode } from "../../src/routes/auth.js";

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

// ─── TOTP helper (SEC-004 tests) ──────────────────────────────────────────────

/**
 * Generate a valid 6-digit TOTP code for a given base32 secret at the
 * current time. SEC-004 tests use this to drive `/mfa/enable` and
 * `/mfa/verify` without depending on a wall-clock-synced authenticator app.
 *
 * Delegates to `_internalGenerateTotpCode` in `backend/src/routes/auth.js`
 * so tests and production share a single TOTP implementation. If production
 * ever drifts (algorithm, digit count, period), tests fail on the same
 * commit instead of silently passing against a stale reference impl.
 *
 * @param {string} secret - Base32 TOTP secret returned by `/mfa/enroll`.
 * @param {number} [offsetSteps=0] - Optional step offset for clock-skew tests.
 * @returns {string} 6-digit code.
 */
export function generateTotpCode(secret, offsetSteps = 0) {
  return _internalGenerateTotpCode(secret, offsetSteps);
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
  "notification_settings",
  "verification_tokens",
  "password_reset_tokens",
  "webhook_tokens",
  "schedules",
  "run_logs",
  "agent_messages",
  "healing_history",
  "activities",
  "runs",
  "tests",
  "oauth_ids",
  // SEC-007: clear the compliance audit-log DLQ + SIEM config between test
  // files so DLQ-N counter restarts don't collide with rows persisted by an
  // earlier test file (the `counters` table is reset below but the data
  // tables aren't — leading to `UNIQUE constraint failed: audit_dlq.id`).
  "audit_dlq",
  "workspace_siem_config",
  // SEC-004: webauthn_credentials cascade-deletes via FK ON DELETE CASCADE
  // from users, but list it explicitly to match the established pattern —
  // every entity table is reset by name so test isolation doesn't depend
  // on FK behaviour that could be altered (or temporarily disabled by
  // `PRAGMA foreign_keys = OFF`) in a future test setup change.
  "webauthn_credentials",
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
  // SEC-007: re-seed the system sentinel user + workspace that migration
  // 033 installs at startup. `resetDb` wipes the entire `workspaces` and
  // `users` tables, but production code (`auth.login.failed` for unknown
  // emails) assumes the `__system__` row exists — otherwise the FK on
  // `activities.workspaceId` fires and the route 500s instead of 401.
  // This mirrors the migration's INSERT OR IGNORE so the contract holds
  // for every test file. Matches the `INSERT OR IGNORE INTO counters`
  // re-seed pattern used elsewhere in the migration suite.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, passwordHash, role, createdAt, updatedAt)
       VALUES ('__system__', 'System', '__system__@__system__.invalid', NULL, 'system',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt)
       VALUES ('__system__', 'System (auto-managed)', '__system__', '__system__',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
  } catch { /* tables may not exist on legacy/partial schemas */ }
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
 * Default per-test timeout (ms). A hung test (e.g. an unawaited `fetch` against
 * a dead listen socket, a `waitFor` against a selector that never appears)
 * would otherwise block the whole suite until the CI job-level timeout fires
 * — at which point we lose the per-test name and stack. 30 000 ms is a
 * deliberately generous ceiling: real unit tests finish in <100 ms; integration
 * tests that genuinely need longer should bump the per-call `timeout` option.
 */
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

/**
 * Tests slower than this threshold (ms) get a `⏱  Nms` marker appended to
 * their pass line. Surfaces creeping slowness before it becomes a CI tax.
 * Matches the `node:test --test-reporter=spec` slow-test highlight (>75 ms
 * default; we use 500 ms because this suite mixes unit + integration files).
 */
const SLOW_TEST_THRESHOLD_MS = 500;

/**
 * Race a promise against a timeout. Resolves with the promise's value on
 * settle, rejects with a structured `Error` on timeout. Keeps the original
 * test name in the error message so the failure line is self-describing
 * even when grepped out of CI logs.
 *
 * @param {Promise<any>} promise
 * @param {number} ms
 * @param {string} testName
 * @returns {Promise<any>}
 */
function raceWithTimeout(promise, ms, testName) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Test "${testName}" exceeded ${ms} ms timeout`));
      }, ms);
      // Allow the process to exit if the test promise resolves first — the
      // timer would otherwise keep the event loop alive past `summary()`.
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Create a mini test runner with pass/fail counting and standard debug
 * ergonomics (stack traces, per-test timing, slow-test markers, default
 * timeout, name-filter + bail env knobs).
 *
 * ### Debug knobs (env vars)
 * - `TEST_FILTER=<substring>` — only run tests whose name contains the
 *   substring (case-insensitive). Skipped tests are reported as `⊝  skipped`
 *   so the filter doesn't silently hide them.
 * - `TEST_BAIL=1` — stop the file on the first failure. Useful when
 *   iterating on a single broken case without scrolling past unrelated
 *   noise.
 * - `TEST_VERBOSE=1` — print full stack on failure even when the error has
 *   a `cause` chain (default already prints `err.stack`; this is the
 *   escape hatch for nested causes).
 *
 * ### Per-call overrides
 * `test(name, fn, { timeout })` lets a single slow test bump the default
 * without changing the runner-wide ceiling.
 *
 * @returns {{ test: Function, summary: Function, passed: number, failed: number, skipped: number }}
 */
export function createTestRunner() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failedTests = [];
  // Track every test invocation so `summary()` can wait for in-flight async
  // tests before reading the counters. Without this, bare top-level
  // `test(...); test(...); summary();` (the pattern in ~half the suite)
  // would exit with `0 passed, 0 failed` because `summary()` runs before
  // any microtask resolves. With this, callers no longer need the
  // `async function main() { await test(...) ... summary(); }` wrapper —
  // the wrapper is still supported (a resolved promise is a no-op in
  // `Promise.all`) but no longer required.
  const pending = [];

  const filter = (process.env.TEST_FILTER || "").toLowerCase();
  const bail = process.env.TEST_BAIL === "1" || process.env.TEST_BAIL === "true";
  const verbose = process.env.TEST_VERBOSE === "1" || process.env.TEST_VERBOSE === "true";
  let bailed = false;

  /**
   * Run a named test function and track pass/fail.
   *
   * @param {string}   name — Test description.
   * @param {Function} fn — Async test function (should throw on failure).
   * @param {Object}   [opts]
   * @param {number}   [opts.timeout=DEFAULT_TEST_TIMEOUT_MS] — Per-test
   *   timeout (ms). Bump for tests that legitimately need longer than the
   *   30 s default (e.g. browser-pool warmups).
   */
  function test(name, fn, opts = {}) {
    if (bailed) {
      skipped++;
      console.log(`  ⊝  ${name}  (bailed)`);
      return Promise.resolve();
    }
    if (filter && !name.toLowerCase().includes(filter)) {
      skipped++;
      // Don't spam — only log skips when explicitly verbose to keep the
      // filtered run output focused on what's actually running.
      if (verbose) console.log(`  ⊝  ${name}  (filtered)`);
      return Promise.resolve();
    }

    const timeoutMs = Number.isFinite(opts.timeout) ? opts.timeout : DEFAULT_TEST_TIMEOUT_MS;
    const startedAt = Date.now();

    // Bug-fix (post-migration): try the body synchronously FIRST. Pre-migration
    // the inline `function test(name, fn) { try { fn(); … } catch { … } }` ran
    // every sync body inline — files relied on this to do
    //     test("seed", () => { db.exec("INSERT …") });
    //     test("assert", () => { db.prepare("SELECT …").get(); });
    //     db.exec("DELETE FROM projects");   // ← cleanup, runs IMMEDIATELY
    //     summary("file-label");
    // …and the cleanup observed both tests' inserts before running. Our
    // earlier `raceWithTimeout(Promise.resolve().then(fn), …)` always
    // deferred via a microtask, so the cleanup ran BEFORE either test body
    // touched the DB → 14 CI failures (FK errors, lost inserts, env-restore
    // races). The fix below restores the synchronous-by-default contract:
    //   • sync test bodies run inline (no microtask boundary)
    //   • bodies that return a Promise still go through the timeout race
    //   • thrown sync errors still bubble through `.catch()` for stack output
    let bodyResult;
    let syncThrew = null;
    try {
      bodyResult = fn();
    } catch (err) {
      syncThrew = err;
    }
    const settled = syncThrew
      ? Promise.reject(syncThrew)
      : (bodyResult && typeof bodyResult.then === "function"
        ? raceWithTimeout(bodyResult, timeoutMs, name)
        : Promise.resolve(bodyResult));
    // Build the per-test promise eagerly and register it in `pending` so
    // `summary()` can await it without the caller needing to `await test()`.
    // Returned to the caller too — preserves the `await test(...)` pattern
    // for files that DO want sequential ordering (e.g. tests that mutate
    // shared DB state between cases).
    const promise = settled
      .then(() => {
        const elapsed = Date.now() - startedAt;
        passed++;
        const slow = elapsed >= SLOW_TEST_THRESHOLD_MS ? `  ⏱  ${elapsed}ms` : "";
        console.log(`  ✅  ${name}${slow}`);
      })
      .catch((err) => {
        const elapsed = Date.now() - startedAt;
        failed++;
        failedTests.push({ name, message: err?.message || String(err) });
        // Use `console.error` so CI stderr capture surfaces failures even
        // when the consumer is grepping stdout for "FAIL"-style markers.
        console.error(`  ❌  ${name}  (${elapsed}ms)`);
        // Full stack — the single most common debugging complaint with the
        // previous runner was "I can't tell which file/line threw".
        const stack = err?.stack || `      ${err?.message || err}`;
        console.error(indent(stack, "      "));
        // Walk `err.cause` chain in verbose mode — Node's AggregateError +
        // fetch failures often hide the real cause one level down.
        if (verbose && err?.cause) {
          console.error(`      Caused by:`);
          console.error(indent(err.cause.stack || String(err.cause), "        "));
        }
        if (bail) {
          bailed = true;
          console.error(`\n  ⛔ Bailing on first failure (TEST_BAIL=1)`);
        }
      });
    pending.push(promise);
    return promise;
  }

  /**
   * Print summary and exit with the appropriate status code.
   *
   * INF-007: explicitly `process.exit(0)` on success rather than letting the
   * event loop drain naturally. `prom-client`'s `collectDefaultMetrics`
   * (transitively imported by anything that touches `utils/metrics.js`) starts
   * internal `perf_hooks.monitorEventLoopDelay` handles that remain ref'd in
   * v15 — `collectDefaultMetrics()` returns void, so the `.unref()` pattern
   * used elsewhere can't reach them. Without an explicit exit, test processes
   * would hang for ~10s per file waiting for those handles to time out.
   * Matches what most Node test runners do (Jest, Mocha, node:test).
   *
   * @param {string} [label] — Optional label for the summary line.
   */
  async function summary(label) {
    // Drain any test() promises the caller didn't await. This is what
    // lets a file written as `test("a", …); test("b", …); summary();`
    // (no `await`, no `main()` wrapper) report accurate counts — the
    // bare-top-level pattern is now safe by construction.
    //
    // Iterate-with-pop instead of a single `Promise.all(pending)` so any
    // late-registered test from a `then()` chain inside a test body is
    // also drained. New entries added during the await loop back into
    // the next iteration; the loop exits when no new tests appear.
    while (pending.length > 0) {
      const batch = pending.splice(0, pending.length);
      await Promise.allSettled(batch);
    }

    const tail = skipped > 0 ? `, ${skipped} skipped` : "";
    console.log(`\n  ${passed} passed, ${failed} failed${tail}`);
    if (failed > 0) {
      // Recap of failed test names so a long file's failures are visible
      // without scrolling back through the per-test output. Mirrors what
      // `node:test --test-reporter=spec` prints at the end of a run.
      console.error(`\n  Failed tests:`);
      for (const f of failedTests) {
        console.error(`    ❌  ${f.name}`);
        console.error(`        ${f.message}`);
      }
      process.exit(1);
    }
    if (label) console.log(`\n🎉 All ${label} tests passed!`);
    process.exit(0);
  }

  return {
    test,
    summary,
    get passed() { return passed; },
    get failed() { return failed; },
    get skipped() { return skipped; },
  };
}

/**
 * Indent every line of a multi-line string with the given prefix. Used to
 * align stack traces under the `❌  <name>` line.
 *
 * @param {string} text
 * @param {string} prefix
 * @returns {string}
 */
function indent(text, prefix) {
  return String(text)
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
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
    generateTotpCode,
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
