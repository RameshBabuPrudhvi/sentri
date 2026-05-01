/**
 * @module utils/ephemeralStorage
 * @description Best-effort detection of ephemeral DB storage at boot (INF-006).
 *
 * Render / Fly / Railway free-tier web service filesystems are ephemeral —
 * every redeploy gets a fresh disk and `backend/data/sentri.db` resets to
 * empty, silently wiping accounts, projects, tests, and runs. This module
 * surfaces the symptom as a single visible log line at boot so operators
 * notice the misconfiguration before they lose data on their second deploy.
 *
 * The probe is skipped entirely when `DATABASE_URL` is set (Postgres mode);
 * otherwise it resolves the SQLite DB path the same way the SQLite adapter
 * (`backend/src/database/adapters/sqlite-adapter.js`) does, then writes a
 * `*.boot-marker` file alongside the DB. On a redeploy where the disk
 * survived, the marker's mtime is older than the freshness window and the
 * warning is suppressed; on ephemeral storage the marker is missing and the
 * warning fires.
 *
 * @exports warnIfEphemeralStorage
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatLogLine } from "./logFormatter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// A marker older than this is treated as proof the filesystem persisted across
// the previous boot. Within the freshness window we assume the marker was
// written by the *current* process, not a prior one, and warn.
const MARKER_FRESHNESS_MS = 10_000;

/**
 * Resolve the default SQLite DB path. Mirrors the SQLite adapter's default at
 * `backend/src/database/adapters/sqlite-adapter.js` so this probe and the
 * adapter never disagree about where the DB lives.
 *
 * @returns {string} Absolute path to the default SQLite DB file.
 */
function defaultDbPath() {
  // backend/src/utils/ephemeralStorage.js → backend/data/sentri.db
  return path.join(__dirname, "..", "..", "data", "sentri.db");
}

/**
 * Emit a warning if the configured SQLite DB path looks ephemeral.
 *
 * No-op (returns early) when `DATABASE_URL` is set — Postgres deployments are
 * always durable, regardless of the host filesystem.
 *
 * @param {Object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]    Override env (defaults to `process.env`).
 * @param {Console}           [opts.logger] Override logger (defaults to `console`).
 * @returns {{ warned: boolean, dbPath: string|null }} Outcome for tests/callers.
 */
export function warnIfEphemeralStorage(opts = {}) {
  const env = opts.env || process.env;
  const logger = opts.logger || console;

  if (env.DATABASE_URL) return { warned: false, dbPath: null };

  const rawDbPath = env.DB_PATH || defaultDbPath();
  const dbPath = path.resolve(rawDbPath);
  const markerPath = `${dbPath}.boot-marker`;
  const isTmpPath = dbPath.startsWith("/tmp/") || dbPath === "/tmp";
  let hasPriorProcessWrite = false;

  try {
    const markerStat = fs.statSync(markerPath);
    hasPriorProcessWrite = Date.now() - markerStat.mtimeMs > MARKER_FRESHNESS_MS;
  } catch {
    hasPriorProcessWrite = false;
  }

  const warned = isTmpPath || !hasPriorProcessWrite;
  if (warned) {
    logger.warn(formatLogLine("warn", null, `[db] DB path appears ephemeral — data will be lost on redeploy (path: ${dbPath})`));
  }

  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString());
  } catch {
    // Best-effort marker write only.
  }

  return { warned, dbPath };
}
