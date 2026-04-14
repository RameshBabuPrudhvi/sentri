/**
 * @module utils/idGenerator
 * @description Short, human-readable ID generators backed by SQLite counters.
 *
 * Produces IDs similar to major test management tools:
 * - Tests: `TC-1`, `TC-2` (like TestRail's C1234)
 * - Runs: `RUN-1`, `RUN-2` (like TestRail's R123)
 * - Projects: `PRJ-1`, `PRJ-2`
 * - Activities: `ACT-1`, `ACT-2`
 *
 * Counters are stored in the SQLite `counters` table and incremented atomically.
 *
 * ### Exports
 * - {@link generateTestId}, {@link generateRunId}, {@link generateProjectId}, {@link generateActivityId}
 * - {@link initCountersFromExistingData} — No-op (kept for backward compatibility).
 */

import * as counterRepo from "../database/repositories/counterRepo.js";

/**
 * generateTestId(db) → "TC-1", "TC-2", …
 * @param {Object} [_db] — Ignored (kept for backward compatibility).
 */
export function generateTestId(_db) {
  return `TC-${counterRepo.next("test")}`;
}

/**
 * generateRunId(db) → "RUN-1", "RUN-2", …
 * @param {Object} [_db] — Ignored (kept for backward compatibility).
 */
export function generateRunId(_db) {
  return `RUN-${counterRepo.next("run")}`;
}

/**
 * generateProjectId(db) → "PRJ-1", "PRJ-2", …
 * @param {Object} [_db] — Ignored (kept for backward compatibility).
 */
export function generateProjectId(_db) {
  return `PRJ-${counterRepo.next("project")}`;
}

/**
 * generateActivityId(db) → "ACT-1", "ACT-2", …
 * @param {Object} [_db] — Ignored (kept for backward compatibility).
 */
export function generateActivityId(_db) {
  return `ACT-${counterRepo.next("activity")}`;
}

/**
 * generateWebhookTokenId() → "WH-1", "WH-2", …
 * Used for per-project CI/CD trigger tokens (ENH-011).
 */
export function generateWebhookTokenId() {
  return `WH-${counterRepo.next("webhook")}`;
}

/**
 * No-op — counters are now managed by the SQLite `counters` table.
 * Kept for backward compatibility so existing callers don't break.
 * The migration script (database/migrate.js) seeds the counters table
 * from existing IDs when migrating from the legacy JSON store.
 *
 * @param {Object} [_db] — Ignored.
 */
export function initCountersFromExistingData(_db) {
  // Intentionally empty — counters are seeded during migration.
}
