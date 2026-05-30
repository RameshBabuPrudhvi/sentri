#!/usr/bin/env node
/**
 * @module scripts/lint-migrations
 * @description CR-004 / TD-004 — Fail-fast linter for the migration directory.
 *
 * The migration runner (`backend/src/database/migrationRunner.js`) sorts
 * `.sql` files alphabetically by full filename. Two files sharing the same
 * numeric prefix (e.g. `015_mfa_columns.sql` + `015_run_secret_scan.sql`)
 * are both applied, but their relative order is decided by the alphabetical
 * sort of the SUFFIX — not by any explicit version. This makes the schema
 * order-dependent on filename collisions, which is fragile: adding a new
 * `015_*.sql` later can silently slot itself between two already-applied
 * migrations on a fresh install while running last on an upgraded one.
 *
 * This linter enforces one rule:
 *
 *   Every `.sql` file in `backend/src/database/migrations/` must have a
 *   UNIQUE three-digit numeric prefix (NNN_).
 *
 * Wired into CI by `.github/workflows/ci.yml` so a duplicate-prefix PR
 * fails before the migration ever runs.
 *
 * ### Exit codes
 * - `0` — every prefix is unique.
 * - `1` — one or more prefixes are duplicated; the offending files are
 *   printed to stderr.
 * - `2` — the migrations directory is missing or unreadable (treated as a
 *   real failure rather than a no-op so a typo in the path can't silently
 *   pass CI).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "src", "database", "migrations");

const PREFIX_RE = /^(\d{3})_[^/]+\.sql$/;

// Grandfathered duplicate prefixes that already exist in production
// databases. Renaming an applied migration changes its `schema_migrations`
// version key, which would cause the runner to re-execute the file on
// existing deployments — and the underlying SQL (bare `ALTER TABLE ADD
// COLUMN` per migration 017's convention) is not idempotent at the DDL
// level, only at the runner level. So we tolerate the existing collisions
// (the runner happens to apply them in a consistent alphabetical order
// today) but fail loudly on any NEW collision. Each entry below is a
// frozen audit of what the codebase shipped before this linter existed;
// shrinking the list is a positive-direction change, growing it is not.
//
// Source: §4.2 of `docs/roadmap/sentri-deep-audit-27May2026.md`.
const GRANDFATHERED_DUPLICATE_PREFIXES = new Set([
  "007",
  "015",
  "021",
  "035",
  "036",
  "037",
  "054",
  "059",
]);

function main() {
  let entries;
  try {
    entries = fs.readdirSync(MIGRATIONS_DIR);
  } catch (err) {
    console.error(`[lint-migrations] cannot read ${MIGRATIONS_DIR}: ${err.message}`);
    process.exit(2);
  }

  const sqlFiles = entries.filter((f) => f.endsWith(".sql"));
  const malformed = [];
  const byPrefix = new Map(); // prefix → string[]

  for (const f of sqlFiles) {
    const m = PREFIX_RE.exec(f);
    if (!m) {
      malformed.push(f);
      continue;
    }
    const prefix = m[1];
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(f);
  }

  const duplicates = [...byPrefix.entries()]
    .filter(([prefix, files]) => files.length > 1 && !GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix))
    .sort(([a], [b]) => a.localeCompare(b));

  const grandfathered = [...byPrefix.entries()]
    .filter(([prefix, files]) => files.length > 1 && GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix))
    .sort(([a], [b]) => a.localeCompare(b));

  let failed = false;

  if (malformed.length > 0) {
    failed = true;
    console.error(
      "[lint-migrations] ❌ malformed migration filenames (expected NNN_description.sql):",
    );
    for (const f of malformed.sort()) console.error(`  - ${f}`);
  }

  if (duplicates.length > 0) {
    failed = true;
    console.error(
      `[lint-migrations] ❌ duplicate numeric prefixes (${duplicates.length}):`,
    );
    for (const [prefix, files] of duplicates) {
      console.error(`  ${prefix}:`);
      for (const f of files.sort()) console.error(`    - ${f}`);
    }
    console.error(
      "\nFix: renumber one of each colliding pair to the next free prefix " +
        "and update any in-code references (changelog entries, ROADMAP, etc.).",
    );
  }

  if (grandfathered.length > 0) {
    console.warn(
      `[lint-migrations] ⚠️  ${grandfathered.length} grandfathered duplicate prefix(es) — tolerated, do not extend:`,
    );
    for (const [prefix, files] of grandfathered) {
      console.warn(`  ${prefix}: ${files.sort().join(", ")}`);
    }
  }

  if (failed) process.exit(1);

  console.log(
    `[lint-migrations] ✅ ${sqlFiles.length} migration files, ${byPrefix.size} unique prefixes — no new collisions.`,
  );
}

main();
