/**
 * @module db
 * @description Simple in-memory store with periodic JSON persistence.
 *
 * Data is written to disk every 30 seconds and on process exit so a crash
 * during test execution doesn't wipe everything.
 * Swap for PostgreSQL/SQLite in production.
 *
 * @example
 * import { getDb, saveDb } from "./db.js";
 *
 * const db = getDb();
 * db.projects["PRJ-1"] = { id: "PRJ-1", name: "My App", url: "https://example.com" };
 * saveDb(); // flush to disk immediately
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatLogLine } from "./utils/logFormatter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "sentri-db.json");
const PERSIST_INTERVAL_MS = 30_000;

let _db = null;

function loadFromDisk() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, "utf-8");
      const data = JSON.parse(raw);
      console.log(formatLogLine("info", null, `[db] Restored from ${DB_PATH} — ${Object.keys(data.projects || {}).length} projects, ${Object.keys(data.tests || {}).length} tests`));
      return data;
    }
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[db] Failed to load ${DB_PATH}, starting fresh: ${err.message}`));
  }
  return null;
}

function saveToDisk(db) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Write to a temp file first, then atomically rename — prevents
    // truncated/corrupt JSON if the process crashes mid-write.
    const tmpPath = DB_PATH + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(db), "utf-8");
    fs.renameSync(tmpPath, DB_PATH);
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[db] Persist failed: ${err.message}`));
  }
}

/**
 * Immediately flush the current DB state to disk.
 * Call after any write that must survive a crash or nodemon restart
 * (e.g. creating a new run, registering a user).
 *
 * @returns {void}
 */
export function saveDb() {
  if (_db) saveToDisk(_db);
}

/**
 * Returns the singleton in-memory database object.
 * On first call, loads from disk (if available), initialises missing keys,
 * recovers orphaned runs, and starts periodic persistence.
 *
 * @returns {DatabaseSchema} The database object with all collections.
 *
 * @typedef {Object} DatabaseSchema
 * @property {Object<string, User>}           users          - Registered users keyed by ID
 * @property {Object<string, string>}         oauthIds       - OAuth provider links: `"github:12345"` → userId
 * @property {Object<string, Project>}        projects       - Projects keyed by ID (e.g. `"PRJ-1"`)
 * @property {Object<string, Test>}           tests          - Tests keyed by ID (e.g. `"TC-1"`)
 * @property {Object<string, Run>}            runs           - Runs keyed by ID (e.g. `"RUN-1"`)
 * @property {Object<string, Activity>}       activities     - Activity log entries keyed by ID
 * @property {Object<string, HealingEntry>}   healingHistory - Self-healing history keyed by `"<testId>::<action>::<label>"`
 */
export function getDb() {
  if (!_db) {
    const restored = loadFromDisk();

    _db = restored || {
      users: {},
      oauthIds: {},
      projects: {},
      tests: {},
      runs: {},
      // Activity log: captures all user/system actions so the Work page can
      // show a complete timeline — not just runs.
      // Type convention — dot-separated: <resource>.<action>
      //   project.create
      //   crawl.start / crawl.complete / crawl.fail
      //   test_run.start / test_run.complete / test_run.fail
      //   test.create / test.generate / test.regenerate / test.edit / test.delete
      //   test.approve / test.reject / test.restore
      //   test.bulk_approve / test.bulk_reject / test.bulk_restore
      //   settings.update
      // Each entry: { id, type, projectId, projectName, testId?, testName?,
      //              detail?, status, createdAt }
      activities: {},
      // Self-healing history: records which selector strategy succeeded for
      // each element so future runs try the winning strategy first.
      // Key: "<testId>::<action>::<label>" → { strategy, succeededAt, failCount }
      healingHistory: {},
    };

    // Ensure all expected keys exist (restored data may be from an older schema)
    if (!_db.users)           _db.users = {};
    if (!_db.oauthIds)        _db.oauthIds = {};
    if (!_db.activities)      _db.activities = {};
    if (!_db.healingHistory)  _db.healingHistory = {};
    if (!_db.projects)        _db.projects = {};
    if (!_db.tests)           _db.tests = {};
    if (!_db.runs)            _db.runs = {};

    // ── Orphan recovery ───────────────────────────────────────────────────────
    // Any run still marked "running" after a restore is an orphan — its async
    // task died with the previous process. Mark it "interrupted" so the SSE
    // endpoint can close immediately and the UI shows a clear status instead
    // of waiting forever.
    let orphanCount = 0;
    for (const run of Object.values(_db.runs)) {
      if (run.status === "running") {
        run.status = "interrupted";
        run.finishedAt = run.finishedAt || new Date().toISOString();
        run.error = "Server restarted while run was in progress";
        orphanCount++;
      }
    }
    if (orphanCount > 0) {
      console.warn(formatLogLine("warn", null, `[db] Marked ${orphanCount} orphaned run(s) as interrupted`));
      saveToDisk(_db); // persist the corrected statuses immediately
    }

    // Periodic persistence — every 30s
    setInterval(() => saveToDisk(_db), PERSIST_INTERVAL_MS).unref();

    // Flush on clean shutdown
    process.on("beforeExit", () => saveToDisk(_db));
    process.on("SIGINT",     () => { saveToDisk(_db); process.exit(0); });
    process.on("SIGTERM",    () => { saveToDisk(_db); process.exit(0); });
  }
  return _db;
}