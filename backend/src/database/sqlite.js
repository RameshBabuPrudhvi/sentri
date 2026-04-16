/**
 * @module database/sqlite
 * @description Database initialisation and singleton access.
 *
 * Supports two database backends selected by the `DATABASE_URL` environment
 * variable:
 *
 * | `DATABASE_URL` value | Backend | Adapter |
 * |---|---|---|
 * | Not set / does not start with `postgres://` | **SQLite** (default) | `adapters/sqlite-adapter.js` |
 * | Starts with `postgres://` or `postgresql://` | **PostgreSQL** | `adapters/postgres-adapter.js` |
 *
 * Both adapters expose the same interface (`prepare`, `exec`, `transaction`,
 * `pragma`, `close`, `dialect`) so all repository modules work unchanged.
 *
 * ### Schema management
 * All schema changes go through the versioned migration system in
 * `database/migrationRunner.js`. Migration files live in `database/migrations/`
 * as numbered `.sql` files (001_*, 002_*, …). The migration runner is
 * dialect-aware and translates SQLite-specific SQL when running against
 * PostgreSQL.
 *
 * ### Exports
 * - {@link getDatabase} — Returns the singleton database adapter instance.
 * - {@link closeDatabase} — Gracefully close the connection (shutdown hook).
 * - {@link getDatabaseDialect} — Returns `"sqlite"` or `"postgres"`.
 */

import { formatLogLine } from "../utils/logFormatter.js";
import { runMigrations } from "./migrationRunner.js";
import { createSqliteAdapter } from "./adapters/sqlite-adapter.js";

/** @type {Object|null} Database adapter instance */
let _db = null;

/**
 * Detect which database backend to use based on `DATABASE_URL`.
 *
 * @returns {"sqlite"|"postgres"}
 */
function detectDialect() {
  const url = process.env.DATABASE_URL;
  if (url && (url.startsWith("postgres://") || url.startsWith("postgresql://"))) {
    return "postgres";
  }
  return "sqlite";
}

// Eagerly load the PostgreSQL adapter module when DATABASE_URL indicates
// PostgreSQL. Uses top-level await with dynamic import() so the ESM module
// can be loaded on Node 20+ (require() of ESM throws ERR_REQUIRE_ESM on
// Node < 22.12). The import only runs when PostgreSQL is actually configured,
// so SQLite-only deployments never trigger it.
let _pgAdapterModule = null;
if (detectDialect() === "postgres") {
  _pgAdapterModule = await import("./adapters/postgres-adapter.js");
}

/**
 * Return the singleton database adapter instance.
 *
 * On first call, detects the backend from `DATABASE_URL`, creates the
 * appropriate adapter, and runs all pending migrations.
 *
 * The returned object conforms to the db-adapter interface:
 * - `prepare(sql)` → statement with `.run()`, `.get()`, `.all()`
 * - `exec(sql)` — execute raw SQL
 * - `transaction(fn)` — wrap in a transaction
 * - `pragma(str)` — execute PRAGMA (no-op on PostgreSQL)
 * - `close()` — close the connection
 * - `dialect` — `"sqlite"` or `"postgres"`
 *
 * @returns {Object} Database adapter instance
 */
export function getDatabase() {
  if (_db) return _db;

  const dialect = detectDialect();

  if (dialect === "postgres") {
    // Use the pre-loaded PostgreSQL adapter module (loaded via top-level await
    // above). This avoids require() of ESM which fails on Node 20.
    const { createPostgresAdapter } = _pgAdapterModule;
    _db = createPostgresAdapter();
  } else {
    _db = createSqliteAdapter();
  }

  // Run versioned migrations (creates tables on first run, applies
  // incremental changes on subsequent runs). Each migration is tracked
  // in the schema_migrations table and only applied once.
  // Pass translateSql from the pre-loaded module so the migration runner
  // doesn't need to import the postgres adapter itself.
  const migrationOpts = _pgAdapterModule ? { translateSql: _pgAdapterModule.translateSql } : {};
  const { applied } = runMigrations(_db, migrationOpts);
  if (applied.length > 0) {
    console.log(formatLogLine("info", null, `[db] Applied ${applied.length} migration(s): ${applied.join(", ")}`));
  }

  console.log(formatLogLine("info", null, `[db] Database ready (dialect: ${_db.dialect})`));

  return _db;
}

/**
 * Return the current database dialect.
 *
 * @returns {"sqlite"|"postgres"} The active dialect.
 */
export function getDatabaseDialect() {
  if (_db) return _db.dialect;
  return detectDialect();
}

/**
 * Gracefully close the database connection.
 * For SQLite: checkpoints the WAL file before closing.
 * For PostgreSQL: drains the connection pool.
 * Called from shutdown hooks in index.js.
 */
export function closeDatabase() {
  if (_db) {
    try {
      _db.close();
    } catch (err) {
      console.warn(formatLogLine("warn", null, `[db] Close failed: ${err.message}`));
    }
    _db = null;
  }
}
