/**
 * @module database/sqlite
 * @description SQLite database initialisation and singleton access.
 *
 * Uses better-sqlite3 (synchronous, single-writer) with WAL mode for
 * concurrent reads. The database file lives at `data/sentri.db`.
 *
 * ### Exports
 * - {@link getDatabase} — Returns the singleton `better-sqlite3` instance.
 * - {@link closeDatabase} — Gracefully close the connection (shutdown hook).
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatLogLine } from "../utils/logFormatter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "..", "..", "data", "sentri.db");
const DB_DIR = path.dirname(DB_PATH);
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

/** @type {Object|null} better-sqlite3 Database instance */
let _db = null;

/**
 * Return the singleton better-sqlite3 database instance.
 * On first call, creates the data directory (if needed), opens the database,
 * applies pragmas, and runs the schema DDL.
 *
 * @returns {Object} better-sqlite3 Database instance
 */
export function getDatabase() {
  if (_db) return _db;

  // Ensure the data directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);

  // Performance & durability pragmas
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  // Apply schema (all statements use IF NOT EXISTS — safe to re-run)
  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  _db.exec(schema);

  // ── Migrations (idempotent) ──────────────────────────────────────────────
  // Add columns that were introduced after the initial schema.
  const runCols = _db.prepare("PRAGMA table_info(runs)").all().map(c => c.name);
  if (!runCols.includes("currentStep")) {
    _db.exec("ALTER TABLE runs ADD COLUMN currentStep INTEGER DEFAULT 0");
  }
  if (!runCols.includes("rateLimitError")) {
    _db.exec("ALTER TABLE runs ADD COLUMN rateLimitError TEXT");
  }
  if (!runCols.includes("qualityAnalytics")) {
    _db.exec("ALTER TABLE runs ADD COLUMN qualityAnalytics TEXT");
  }

  console.log(formatLogLine("info", null, `[sqlite] Database opened at ${DB_PATH}`));

  return _db;
}

/**
 * Gracefully close the database connection.
 * Called from shutdown hooks in index.js.
 */
export function closeDatabase() {
  if (_db) {
    try {
      _db.close();
      console.log(formatLogLine("info", null, "[sqlite] Database connection closed"));
    } catch (err) {
      console.warn(formatLogLine("warn", null, `[sqlite] Close failed: ${err.message}`));
    }
    _db = null;
  }
}
