/**
 * @module database/adapters/sqlite-adapter
 * @description SQLite adapter implementing the db-adapter interface.
 *
 * Wraps `better-sqlite3` to provide the standard adapter API used by all
 * repository modules.  This is the default adapter when no `DATABASE_URL`
 * environment variable is set (or when it does not start with `postgres://`).
 *
 * ### Adapter interface
 * Every adapter must expose:
 * - `prepare(sql)`  → statement-like object with `.run()`, `.get()`, `.all()`
 * - `exec(sql)`     — execute raw SQL (DDL, multi-statement)
 * - `transaction(fn)` — wrap `fn` in a transaction, return a callable
 * - `pragma(str)`   — execute a PRAGMA (no-op on non-SQLite)
 * - `close()`       — close the connection
 * - `dialect`       — `"sqlite"` or `"postgres"`
 *
 * @exports createSqliteAdapter
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatLogLine } from "../../utils/logFormatter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create a SQLite adapter instance.
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.dbPath] — Override the database file path.
 * @returns {Object} Adapter conforming to the db-adapter interface.
 */
export function createSqliteAdapter(opts = {}) {
  const DB_PATH = opts.dbPath
    ? path.resolve(opts.dbPath)
    : process.env.DB_PATH
      ? path.resolve(process.env.DB_PATH)
      : path.join(__dirname, "..", "..", "..", "data", "sentri.db");
  const DB_DIR = path.dirname(DB_PATH);

  // Ensure the data directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);

  // Performance & durability pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  console.log(formatLogLine("info", null, `[sqlite-adapter] Database opened at ${DB_PATH}`));

  return {
    /** @type {"sqlite"} */
    dialect: "sqlite",

    /**
     * Prepare a SQL statement.
     * Returns the native better-sqlite3 Statement which already has
     * `.run()`, `.get()`, `.all()` methods.
     *
     * @param {string} sql
     * @returns {Object} better-sqlite3 Statement
     */
    prepare(sql) {
      return db.prepare(sql);
    },

    /**
     * Execute raw SQL (DDL, multi-statement scripts).
     * @param {string} sql
     */
    exec(sql) {
      db.exec(sql);
    },

    /**
     * Wrap a function in a database transaction.
     * Returns a callable that executes `fn` inside BEGIN/COMMIT.
     *
     * @param {Function} fn
     * @returns {Function}
     */
    transaction(fn) {
      return db.transaction(fn);
    },

    /**
     * Execute a PRAGMA statement.
     * @param {string} str — e.g. "journal_mode = WAL"
     * @returns {*}
     */
    pragma(str) {
      return db.pragma(str);
    },

    /**
     * Gracefully close the database connection.
     * Checkpoints the WAL file before closing.
     */
    close() {
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.close();
        console.log(formatLogLine("info", null, "[sqlite-adapter] Database connection closed (WAL checkpointed)"));
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[sqlite-adapter] Close failed: ${err.message}`));
      }
    },
  };
}
