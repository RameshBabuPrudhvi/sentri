/**
 * @module database/migrate
 * @description One-time migration from sentri-db.json → SQLite.
 *
 * Called automatically on startup if the SQLite database is empty but the
 * legacy JSON file exists. Safe to run multiple times — skips if data already
 * exists in SQLite.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDatabase } from "./sqlite.js";
import * as projectRepo from "./repositories/projectRepo.js";
import * as testRepo from "./repositories/testRepo.js";
import * as runRepo from "./repositories/runRepo.js";
import * as activityRepo from "./repositories/activityRepo.js";
import * as healingRepo from "./repositories/healingRepo.js";
import * as userRepo from "./repositories/userRepo.js";
import * as counterRepo from "./repositories/counterRepo.js";
import { formatLogLine } from "../utils/logFormatter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_DB_PATH = path.join(__dirname, "..", "..", "data", "sentri-db.json");

/**
 * Check if migration is needed and perform it.
 * Skips if SQLite already has projects or if the legacy JSON file doesn't exist.
 */
export function migrateFromJsonIfNeeded() {
  // Check if legacy file exists
  if (!fs.existsSync(LEGACY_DB_PATH)) {
    return;
  }

  // Check if SQLite already has data (any projects means migration already happened)
  const db = getDatabase();
  const count = db.prepare("SELECT COUNT(*) as cnt FROM projects").get().cnt;
  if (count > 0) {
    console.log(formatLogLine("info", null, "[migrate] SQLite already has data — skipping JSON migration"));
    return;
  }

  console.log(formatLogLine("info", null, `[migrate] Found legacy ${LEGACY_DB_PATH} — migrating to SQLite…`));

  let data;
  try {
    const raw = fs.readFileSync(LEGACY_DB_PATH, "utf-8");
    data = JSON.parse(raw);
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[migrate] Failed to read legacy DB: ${err.message}`));
    return;
  }

  const txn = db.transaction(() => {
    // ── Users ──────────────────────────────────────────────────────────────
    let userCount = 0;
    for (const user of Object.values(data.users || {})) {
      try {
        userRepo.create(user);
        userCount++;
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[migrate] Skipping user ${user.id}: ${err.message}`));
      }
    }

    // ── OAuth IDs ──────────────────────────────────────────────────────────
    let oauthCount = 0;
    for (const [key, userId] of Object.entries(data.oauthIds || {})) {
      try {
        userRepo.setOAuthLink(key, userId);
        oauthCount++;
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[migrate] Skipping oauthId ${key}: ${err.message}`));
      }
    }

    // ── Projects ───────────────────────────────────────────────────────────
    let projCount = 0;
    for (const project of Object.values(data.projects || {})) {
      try {
        projectRepo.create(project);
        projCount++;
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[migrate] Skipping project ${project.id}: ${err.message}`));
      }
    }

    // ── Tests ──────────────────────────────────────────────────────────────
    let testCount = 0;
    for (const test of Object.values(data.tests || {})) {
      try {
        testRepo.create(test);
        testCount++;
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[migrate] Skipping test ${test.id}: ${err.message}`));
      }
    }

    // ── Runs ───────────────────────────────────────────────────────────────
    let runCount = 0;
    for (const run of Object.values(data.runs || {})) {
      try {
        runRepo.create(run);
        runCount++;
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[migrate] Skipping run ${run.id}: ${err.message}`));
      }
    }

    // ── Activities ─────────────────────────────────────────────────────────
    let actCount = 0;
    for (const activity of Object.values(data.activities || {})) {
      try {
        activityRepo.create(activity);
        actCount++;
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[migrate] Skipping activity ${activity.id}: ${err.message}`));
      }
    }

    // ── Healing History ────────────────────────────────────────────────────
    let healCount = 0;
    for (const [key, entry] of Object.entries(data.healingHistory || {})) {
      try {
        healingRepo.set(key, entry);
        healCount++;
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[migrate] Skipping healing ${key}: ${err.message}`));
      }
    }

    // ── Counters ───────────────────────────────────────────────────────────
    // Scan existing IDs to set counters correctly
    function maxNum(obj, prefix) {
      let max = 0;
      for (const key of Object.keys(obj || {})) {
        if (key.startsWith(prefix)) {
          const n = parseInt(key.slice(prefix.length), 10);
          if (n > max) max = n;
        }
      }
      return max;
    }
    counterRepo.set("test", maxNum(data.tests, "TC-"));
    counterRepo.set("run", maxNum(data.runs, "RUN-"));
    counterRepo.set("project", maxNum(data.projects, "PRJ-"));
    counterRepo.set("activity", maxNum(data.activities, "ACT-"));

    console.log(formatLogLine("info", null,
      `[migrate] Done — ${userCount} users, ${oauthCount} OAuth links, ${projCount} projects, ` +
      `${testCount} tests, ${runCount} runs, ${actCount} activities, ${healCount} healing entries`
    ));
  });

  txn();

  // Rename legacy file so it's not re-imported
  try {
    fs.renameSync(LEGACY_DB_PATH, LEGACY_DB_PATH + ".migrated");
    console.log(formatLogLine("info", null, `[migrate] Renamed ${LEGACY_DB_PATH} → .migrated`));
  } catch {
    console.warn(formatLogLine("warn", null, "[migrate] Could not rename legacy file"));
  }
}
