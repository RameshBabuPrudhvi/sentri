/**
 * @module database/sqlite
 * @description SQLite database initialisation and singleton access.
 *
 * Uses better-sqlite3 (synchronous, single-writer) with WAL mode for
 * concurrent reads. The database file lives at `data/sentri.db`.
 *
 * ### Schema management
 * All schema changes go through the versioned migration system in
 * `database/migrationRunner.js`. Migration files live in `database/migrations/`
 * as numbered `.sql` files (001_*, 002_*, …). See the migration runner JSDoc
 * for instructions on adding new migrations.
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
import { runMigrations } from "./migrationRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "..", "..", "data", "sentri.db");
const DB_DIR = path.dirname(DB_PATH);

/** @type {Object|null} better-sqlite3 Database instance */
let _db = null;

/**
 * Return the singleton better-sqlite3 database instance.
 * On first call, creates the data directory (if needed), opens the database,
 * applies pragmas, and runs all pending migrations.
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

  // Run versioned migrations (creates tables on first run, applies
  // incremental changes on subsequent runs). Each migration is tracked
  // in the schema_migrations table and only applied once.
  const { applied } = runMigrations(_db);
  if (applied.length > 0) {
    console.log(formatLogLine("info", null, `[sqlite] Applied ${applied.length} migration(s): ${applied.join(", ")}`));
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
