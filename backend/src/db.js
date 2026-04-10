/**
 * @module db
 * @description Compatibility shim — delegates to SQLite via repository modules.
 *
 * `getDb()` returns a plain object whose collection properties are populated
 * from SQLite on each call. Pipeline code that mutates `run` objects in-memory
 * must call `saveDb()` (or `runRepo.save(run)`) to flush changes back.
 *
 * `saveDb()` is now a no-op for most cases — individual repo calls persist
 * immediately. It is kept for backward compatibility.
 *
 * ### Migration path
 * Consumers should incrementally move to importing repository modules directly
 * (e.g. `import * as testRepo from "./database/repositories/testRepo.js"`).
 * Once all consumers are migrated, this shim can be deleted.
 *
 * @example
 * import { getDb, saveDb } from "./db.js";
 *
 * const db = getDb();
 * const project = db.projects["PRJ-1"]; // reads from SQLite
 * saveDb(); // no-op
 */

import * as projectRepo from "./database/repositories/projectRepo.js";
import * as testRepo from "./database/repositories/testRepo.js";
import * as runRepo from "./database/repositories/runRepo.js";
import * as activityRepo from "./database/repositories/activityRepo.js";
import * as healingRepo from "./database/repositories/healingRepo.js";
import * as userRepo from "./database/repositories/userRepo.js";
import { getDatabase } from "./database/sqlite.js";

/**
 * No-op — SQLite writes are synchronous and immediately durable.
 * Kept for backward compatibility so existing `saveDb()` calls don't break.
 * @returns {void}
 */
export function saveDb() {
  // Intentionally empty — SQLite persistence is immediate.
}

/**
 * Returns a snapshot of the database as a plain object with dictionary
 * properties for each collection. This matches the shape that all existing
 * consumers expect (`db.projects[id]`, `Object.values(db.tests)`, etc.).
 *
 * **Important:** The returned object is a fresh snapshot. Mutations to the
 * returned objects are NOT automatically persisted — use repository modules
 * directly for writes, or call the specific repo's `update`/`create` methods.
 *
 * @returns {Object} Database snapshot with all collections.
 */
export function getDb() {
  return {
    users: (() => {
      const all = userRepo.getAll();
      const dict = {};
      for (const u of all) dict[u.id] = u;
      return dict;
    })(),
    oauthIds: (() => {
      // oauthIds is a simple key→userId map
      const rows = getDatabase().prepare("SELECT key, userId FROM oauth_ids").all();
      const dict = {};
      for (const r of rows) dict[r.key] = r.userId;
      return dict;
    })(),
    projects: projectRepo.getAllAsDict(),
    tests: testRepo.getAllAsDict(),
    runs: runRepo.getAllAsDict(),
    activities: activityRepo.getAllAsDict(),
    healingHistory: healingRepo.getAllAsDict(),
  };
}