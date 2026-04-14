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

import crypto from "crypto";
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
      checksum    TEXT NOT NULL,          -- SHA-256 of the migration SQL
      appliedAt   TEXT NOT NULL,          -- ISO 8601 timestamp
      durationMs  INTEGER NOT NULL        -- execution time in ms
    )
  `);
  // Add checksum column if upgrading from an older schema_migrations table
  const cols = db.prepare("PRAGMA table_info(schema_migrations)").all().map(c => c.name);
  if (!cols.includes("checksum")) {
    db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
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
 * @param {Object} db — better-sqlite3 Database instance.
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
 * @param {Object} db — better-sqlite3 Database instance.
 * @returns {{ applied: string[], skipped: number }}
 */
export function runMigrations(db) {
  ensureMigrationsTable(db);

  const applied = getAppliedMigrations(db);
  const all = discoverMigrations();

  // Detect already-applied migrations whose file has changed since it was
  // applied. When this happens, re-apply the file so that new idempotent
  // statements (CREATE TABLE/INDEX IF NOT EXISTS, ALTER TABLE ADD COLUMN)
  // bring the schema up to date. This supports the consolidation pattern
  // where incremental migrations are folded back into 001_initial_schema.sql.
  const reapply = [];
  for (const migration of all) {
    const existingChecksum = applied.get(migration.version);
    if (existingChecksum && existingChecksum !== "") {
      const sql = fs.readFileSync(migration.filePath, "utf-8");
      const currentChecksum = checksum(sql);
      if (existingChecksum !== currentChecksum) {
        console.warn(formatLogLine("warn", null,
          `[migrations] ⚠️  ${migration.version} file changed — re-applying ` +
          `(old checksum ${existingChecksum}, new ${currentChecksum})`
        ));
        reapply.push(migration);
      }
    }
  }

  const pending = all.filter(m => !applied.has(m.version)).concat(reapply);

  if (pending.length === 0) {
    return { applied: [], skipped: all.length };
  }

  const results = [];

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.filePath, "utf-8");
    const hash = checksum(sql);
    const start = Date.now();

    const applyMigration = db.transaction(() => {
      // SQLite does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN.
      // If the migration contains ALTER TABLE ADD COLUMN for a column that
      // already exists (e.g. 002 re-adds columns that 001 already created
      // on fresh databases), we fall back to statement-by-statement execution
      // and silently skip "duplicate column name" errors.
      try {
        db.exec(sql);
      } catch (err) {
        if (err.message && err.message.includes("duplicate column name")) {
          // Re-execute statement by statement, skipping duplicate columns.
          // We use a regex to split on semicolons that are NOT inside
          // parentheses (to avoid breaking CREATE TABLE bodies).
          const statements = [];
          let depth = 0;
          let current = "";
          for (const ch of sql) {
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            if (ch === ";" && depth === 0) {
              const trimmed = current.trim();
              if (trimmed.length > 0) statements.push(trimmed);
              current = "";
            } else {
              current += ch;
            }
          }
          const last = current.trim();
          if (last.length > 0) statements.push(last);

          for (const stmt of statements) {
            try {
              db.exec(stmt);
            } catch (stmtErr) {
              if (stmtErr.message && stmtErr.message.includes("duplicate column name")) {
                continue;
              }
              throw stmtErr;
            }
          }
        } else {
          throw err;
        }
      }
      db.prepare(
        "INSERT OR REPLACE INTO schema_migrations (version, checksum, appliedAt, durationMs) VALUES (?, ?, ?, ?)"
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
