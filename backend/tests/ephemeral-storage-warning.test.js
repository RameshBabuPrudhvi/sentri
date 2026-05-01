/**
 * @module tests/ephemeral-storage-warning
 * @description Unit tests for `src/utils/ephemeralStorage.js` (INF-006).
 *
 * Covers all branches of `warnIfEphemeralStorage()`:
 *   1. DATABASE_URL set → no-op (Postgres path)
 *   2. DB_PATH under /tmp → warns (always treated as ephemeral)
 *   3. No prior marker on a fresh disk → warns (cold deploy)
 *   4. Stale marker (> freshness window) → does NOT warn (persistent disk redeploy)
 *   5. Marker write is best-effort: a read-only directory must not throw
 *   6. Boot marker is written next to the resolved DB file
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { warnIfEphemeralStorage } from "../src/utils/ephemeralStorage.js";

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
    console.log(`      ${err.stack || err.message}`);
  }
}

/**
 * Create a fresh temp directory for an isolated DB path. Caller is responsible
 * for cleanup via the returned `cleanup()` function.
 *
 * NOTE: we deliberately avoid `os.tmpdir()` here because on Linux it resolves
 * to `/tmp`, which would trip `warnIfEphemeralStorage()`'s `isTmpPath` branch
 * and force the warning regardless of marker state. Tests that need the
 * `/tmp` branch explicitly construct a `/tmp`-prefixed path of their own.
 */
function makeTempDbDir() {
  // Use a path under cwd (the test runner sets cwd to `backend/`) rather than
  // `os.tmpdir()` so the path doesn't start with `/tmp` and trip isTmpPath.
  const base = path.join(process.cwd(), ".test-tmp", "ephemeral-storage");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "case-"));
  const dbPath = path.join(dir, "sentri.db");
  return {
    dir,
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Capture a single `logger.warn` call without polluting stdout. */
function captureLogger() {
  const calls = [];
  return {
    logger: { warn: (...args) => calls.push(args) },
    calls,
  };
}

console.log("\n🧪 ephemeral-storage warning (INF-006)");

test("no-op when DATABASE_URL is set (Postgres path)", () => {
  const { logger, calls } = captureLogger();
  const result = warnIfEphemeralStorage({
    env: { DATABASE_URL: "postgres://user:pass@host:5432/sentri", DB_PATH: "/tmp/should-not-warn.db" },
    logger,
  });
  assert.equal(result.warned, false);
  assert.equal(result.dbPath, null);
  assert.equal(calls.length, 0, "warn must not fire when DATABASE_URL is set");
});

test("warns when DB_PATH is under /tmp", () => {
  const { dir, cleanup } = makeTempDbDir();
  // Build a /tmp-prefixed path that we can also clean up.
  const tmpDb = path.join("/tmp", path.basename(dir), "sentri.db");
  fs.mkdirSync(path.dirname(tmpDb), { recursive: true });
  try {
    const { logger, calls } = captureLogger();
    const result = warnIfEphemeralStorage({
      env: { DB_PATH: tmpDb },
      logger,
    });
    assert.equal(result.warned, true);
    assert.equal(calls.length, 1);
    assert.match(String(calls[0][0]), /ephemeral/i);
    assert.match(String(calls[0][0]), /redeploy/i);
  } finally {
    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
    cleanup();
  }
});

test("warns on fresh deploy with no prior boot marker", () => {
  const { dbPath, cleanup } = makeTempDbDir();
  try {
    const { logger, calls } = captureLogger();
    const result = warnIfEphemeralStorage({
      env: { DB_PATH: dbPath },
      logger,
    });
    assert.equal(result.warned, true, "no marker → must warn");
    assert.equal(result.dbPath, path.resolve(dbPath));
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test("does NOT warn when a stale marker exists (persistent disk redeploy)", () => {
  const { dbPath, cleanup } = makeTempDbDir();
  try {
    // Pre-seed a marker that's older than the freshness window (10s).
    const markerPath = `${path.resolve(dbPath)}.boot-marker`;
    fs.writeFileSync(markerPath, "prior-boot");
    const stale = Date.now() - 60_000; // 60s ago
    fs.utimesSync(markerPath, stale / 1000, stale / 1000);

    const { logger, calls } = captureLogger();
    const result = warnIfEphemeralStorage({
      env: { DB_PATH: dbPath },
      logger,
    });
    assert.equal(result.warned, false, "stale marker → must NOT warn");
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test("writes a boot marker next to the resolved DB file", () => {
  const { dbPath, cleanup } = makeTempDbDir();
  try {
    const { logger } = captureLogger();
    warnIfEphemeralStorage({ env: { DB_PATH: dbPath }, logger });
    const markerPath = `${path.resolve(dbPath)}.boot-marker`;
    assert.ok(fs.existsSync(markerPath), "boot marker should be written");
    const contents = fs.readFileSync(markerPath, "utf8");
    // ISO timestamp like 2026-04-30T12:34:56.789Z
    assert.match(contents, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup();
  }
});

test("marker write failure is swallowed (best-effort) and warning still fires", () => {
  // Point DB_PATH at a path under a directory we'll make read-only so the
  // marker write fails. POSIX-only — skip on Windows.
  if (process.platform === "win32") {
    console.log("  ⏭   skipped on win32");
    passed += 1;
    return;
  }
  const { dir, cleanup } = makeTempDbDir();
  const lockedDir = path.join(dir, "readonly");
  fs.mkdirSync(lockedDir);
  // 0o500 = r-x for owner only; writeFileSync inside will EACCES.
  // Marker write failure must not throw out of warnIfEphemeralStorage.
  fs.chmodSync(lockedDir, 0o500);
  const dbPath = path.join(lockedDir, "sentri.db");
  try {
    const { logger, calls } = captureLogger();
    const result = warnIfEphemeralStorage({
      env: { DB_PATH: dbPath },
      logger,
    });
    assert.equal(result.warned, true, "no marker yet → still warns");
    assert.equal(calls.length, 1);
  } finally {
    fs.chmodSync(lockedDir, 0o700); // restore so cleanup works
    cleanup();
  }
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  Ephemeral-storage warning tests failed");
  process.exit(1);
}

console.log("\n🎉 Ephemeral-storage warning tests passed");
