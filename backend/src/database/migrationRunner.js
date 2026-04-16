/**
 * @module database/migrationRunner
 * @description Versioned, dialect-aware database migration runner.
 *
 * Implements a standard sequential migration pattern:
 *   1. A `schema_migrations` table tracks which migrations have been applied.
 *   2. Migration files live in `migrations/` as numbered `.sql` files (001_*, 002_*, …).
 *   3. On startup, the runner scans for unapplied migrations and executes them
 *      in order inside a transaction.
 *   4. Each migration is recorded with its name and timestamp so the history
 *      is auditable.
 *
 * ### Dialect awareness (INF-001)
 * The runner accepts a database adapter (not a raw `better-sqlite3` instance).
 * When the adapter's `dialect` is `"postgres"`, the runner translates
 * SQLite-specific SQL in migration files using the PostgreSQL adapter's
 * `translateSql()` function before execution.
 *
 * ### Adding a new migration
 * 1. Create `backend/src/database/migrations/NNN_description.sql`
 *    (NNN = zero-padded sequence number, e.g. `002_add_foo_column.sql`).
 * 2. Write idempotent SQL (use `IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` guards).
 * 3. Restart the server — the migration runs automatically.
 *
 * ### Exports
 * - {@link runMigrations} — Apply all pending migrations.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { formatLogLine } from "../utils/logFormatter.js";

const _require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/**
 * Ensure the schema_migrations tracking table exists.
 * @param {Object} db — Database adapter instance.
 */
function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,      -- e.g. "001_initial_schema"
      checksum    TEXT NOT NULL,          -- SHA-256 of the migration SQL
      appliedAt   TEXT NOT NULL,          -- ISO 8601 timestamp
      durationMs  INTEGER NOT NULL        -- execution time in ms
    )
  `);
  // Add checksum column if upgrading from an older schema_migrations table.
  // Use PRAGMA table_info on SQLite; information_schema on PostgreSQL.
  if (db.dialect === "postgres") {
    const cols = db.prepare(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'schema_migrations'"
    ).all().map(c => c.name);
    if (!cols.includes("checksum")) {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
    }
  } else {
    const cols = db.prepare("PRAGMA table_info(schema_migrations)").all().map(c => c.name);
    if (!cols.includes("checksum")) {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
    }
  }
}

/**
 * Compute SHA-256 checksum of a migration file's contents.
 * @param {string} sql
 * @returns {string}
 */
function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

/**
 * Get already-applied migrations as a Map of version → checksum.
 * @param {Object} db — Database adapter instance.
 * @returns {Map<string, string>}
 */
function getAppliedMigrations(db) {
  const rows = db.prepare("SELECT version, checksum FROM schema_migrations").all();
  const map = new Map();
  for (const r of rows) map.set(r.version, r.checksum || "");
  return map;
}

/**
 * Discover all migration files sorted by filename.
 * @returns {Array<{version: string, filePath: string}>}
 */
function discoverMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort()
    .map(f => ({
      version: f.replace(/\.sql$/, ""),
      filePath: path.join(MIGRATIONS_DIR, f),
    }));
}

/**
 * Apply all pending migrations in order.
 *
 * Each migration runs inside its own transaction. If a migration fails,
 * that transaction is rolled back and the error is thrown — subsequent
 * migrations are NOT attempted.
 *
 * @param {Object} db — Database adapter instance (SQLite or PostgreSQL).
 * @returns {{ applied: string[], skipped: number }}
 */
export function runMigrations(db) {
  ensureMigrationsTable(db);

  // Lazy-load translateSql only when running against PostgreSQL.
  // This avoids importing the postgres-adapter module (and its pg dependency)
  // when using SQLite.
  let translateSql = null;
  if (db.dialect === "postgres") {
    try {
      const mod = await_import_postgres_adapter();
      translateSql = mod.translateSql;
    } catch (err) {
      console.warn(formatLogLine("warn", null,
        `[migrations] Could not load translateSql from postgres-adapter: ${err.message}`
      ));
    }
  }

  const applied = getAppliedMigrations(db);
  const all = discoverMigrations();

  // Validate checksums of already-applied migrations — detect tampered files.
  // A changed migration file means the DB schema may be inconsistent with
  // what the code expects. Warn loudly but don't crash (the change may be
  // intentional, e.g. a comment fix).
  for (const migration of all) {
    const existingChecksum = applied.get(migration.version);
    if (existingChecksum && existingChecksum !== "") {
      const sql = fs.readFileSync(migration.filePath, "utf-8");
      const currentChecksum = checksum(sql);
      if (existingChecksum !== currentChecksum) {
        console.warn(formatLogLine("warn", null,
          `[migrations] ⚠️  ${migration.version} file changed after it was applied ` +
          `(expected checksum ${existingChecksum}, got ${currentChecksum}). ` +
          `This may indicate an inconsistent schema.`
        ));
      }
    }
  }

  const pending = all.filter(m => !applied.has(m.version));

  if (pending.length === 0) {
    return { applied: [], skipped: all.length };
  }

  const results = [];

  for (const migration of pending) {
    const rawSql = fs.readFileSync(migration.filePath, "utf-8");
    const hash = checksum(rawSql);
    const start = Date.now();

    // Translate SQLite-specific SQL to PostgreSQL when needed.
    // The checksum is always computed on the raw (untranslated) SQL so it
    // stays consistent regardless of which dialect applies the migration.
    const sql = translateSql ? translateSql(rawSql) : rawSql;

    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, checksum, appliedAt, durationMs) VALUES (?, ?, ?, ?)"
      ).run(migration.version, hash, new Date().toISOString(), Date.now() - start);
    });

    try {
      applyMigration();
      const ms = Date.now() - start;
      results.push(migration.version);
      console.log(formatLogLine("info", null, `[migrations] ✅ ${migration.version} (${ms}ms) [${hash}]`));
    } catch (err) {
      console.error(formatLogLine("error", null, `[migrations] ❌ ${migration.version} failed: ${err.message}`));
      throw err;
    }
  }

  return { applied: results, skipped: all.length - pending.length };
}

// ─── Lazy import helper ───────────────────────────────────────────────────────

/**
 * Lazy-load the postgres-adapter module for its translateSql function.
 * Uses createRequire so the import is synchronous and doesn't fail when
 * pg/pg-native are not installed (the module is only loaded when dialect
 * is "postgres", which means those deps are available).
 *
 * @returns {{ translateSql: Function }}
 */
function await_import_postgres_adapter() {
  return _require("./adapters/postgres-adapter.js");
}
