/**
 * @module database/migrationRunner
 * @description Versioned database migration runner.
 *
 * Implements a standard sequential migration pattern:
 *   1. A `schema_migrations` table tracks which migrations have been applied.
 *   2. Migration files live in `migrations/` as numbered `.sql` files (001_*, 002_*, …).
 *   3. On startup, the runner scans for unapplied migrations and executes them
 *      in order inside a transaction.
 *   4. Each migration is recorded with its name and timestamp so the history
 *      is auditable.
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

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatLogLine } from "../utils/logFormatter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/**
 * Ensure the schema_migrations tracking table exists.
 * @param {Object} db — better-sqlite3 Database instance.
 */
function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,      -- e.g. "001_initial_schema"
      appliedAt   TEXT NOT NULL,         -- ISO 8601 timestamp
      durationMs  INTEGER NOT NULL       -- execution time in ms
    )
  `);
}

/**
 * Get the set of already-applied migration versions.
 * @param {Object} db — better-sqlite3 Database instance.
 * @returns {Set<string>}
 */
function getAppliedMigrations(db) {
  const rows = db.prepare("SELECT version FROM schema_migrations").all();
  return new Set(rows.map(r => r.version));
}

/**
 * Discover all migration files sorted by filename.
 * @returns {{ version: string, filePath: string }[]}
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
 * @param {Object} db — better-sqlite3 Database instance.
 * @returns {{ applied: string[], skipped: number }}
 */
export function runMigrations(db) {
  ensureMigrationsTable(db);

  const applied = getAppliedMigrations(db);
  const all = discoverMigrations();
  const pending = all.filter(m => !applied.has(m.version));

  if (pending.length === 0) {
    return { applied: [], skipped: all.length };
  }

  const results = [];

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.filePath, "utf-8");
    const start = Date.now();

    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, appliedAt, durationMs) VALUES (?, ?, ?)"
      ).run(migration.version, new Date().toISOString(), Date.now() - start);
    });

    try {
      applyMigration();
      const ms = Date.now() - start;
      results.push(migration.version);
      console.log(formatLogLine("info", null, `[migrations] ✅ ${migration.version} (${ms}ms)`));
    } catch (err) {
      console.error(formatLogLine("error", null, `[migrations] ❌ ${migration.version} failed: ${err.message}`));
      throw err;
    }
  }

  return { applied: results, skipped: all.length - pending.length };
}
