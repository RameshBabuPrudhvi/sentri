/**
 * @module database/repositories/counterRepo
 * @description Atomic counter management for human-readable IDs (TC-1, RUN-2, etc.).
 */

import { getDatabase } from "../sqlite.js";

/**
 * Atomically increment a counter and return the new value.
 * @param {string} name — Counter name ("test", "run", "project", "activity").
 * @returns {number} The new counter value.
 */
export function next(name) {
  const db = getDatabase();
  const stmt = db.prepare("UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value");
  const row = stmt.get(name);
  if (!row) throw new Error(`Unknown counter: "${name}"`);
  return row.value;
}

/**
 * Get the current value of a counter without incrementing.
 * @param {string} name
 * @returns {number}
 */
export function current(name) {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM counters WHERE name = ?").get(name);
  return row ? row.value : 0;
}

/**
 * Set a counter to a specific value (used during migration).
 * @param {string} name
 * @param {number} value
 */
export function set(name, value) {
  const db = getDatabase();
  db.prepare("UPDATE counters SET value = ? WHERE name = ?").run(value, name);
}
