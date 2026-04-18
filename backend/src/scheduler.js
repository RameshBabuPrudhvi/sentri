/**
 * @module scheduler
 * @description Cron-based test run scheduler (ENH-006).
 *
 * Manages one `node-cron` task per project schedule.  Tasks are stored in a
 * process-local Map keyed by projectId.  On startup the server calls
 * {@link initScheduler} which loads every enabled schedule from the DB and
 * arms each cron task.  When a project's schedule is created, updated, or
 * toggled, the caller invokes {@link reloadSchedule} to apply the change
 * without a process restart.
 *
 * ### Firing logic
 * When a cron task fires it behaves identically to `POST /api/projects/:id/run`:
 * - Loads the project and its approved tests from the DB.
 * - Skips if an active run is already in progress (prevents double-runs).
 * - Creates a `test_run` run record and hands off to `runWithAbort`.
 * - Records `lastRunAt` / `nextRunAt` via `scheduleRepo.updateRunTimes()`.
 * - Logs a `scheduled_run.start` activity entry.
 *
 * ### Exports
 * - {@link initScheduler}   — Load all enabled schedules at startup.
 * - {@link reloadSchedule}  — Upsert a single project's task (create/update/toggle).
 * - {@link stopSchedule}    — Cancel and remove a task (project deleted).
 * - {@link getNextRunAt}    — Compute the ISO next-fire time for a cron expression.
 */

import cron from "node-cron";
import * as scheduleRepo from "./database/repositories/scheduleRepo.js";
import * as projectRepo from "./database/repositories/projectRepo.js";
import * as testRepo from "./database/repositories/testRepo.js";
import * as runRepo from "./database/repositories/runRepo.js";
import { generateRunId } from "./utils/idGenerator.js";
import { runWithAbort } from "./utils/runWithAbort.js";
import { runTests } from "./testRunner.js";
import { logActivity } from "./utils/activityLogger.js";
import { classifyError } from "./utils/errorClassifier.js";
import { formatLogLine } from "./utils/logFormatter.js";
import { fireNotifications } from "./utils/notifications.js";

// ─── Task registry ─────────────────────────────────────────────────────────────
// Maps projectId → node-cron ScheduledTask
/** @type {Map<string, Object>} projectId → node-cron ScheduledTask */
const tasks = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract date/time components from a UTC timestamp in a given IANA timezone.
 *
 * Uses `Intl.DateTimeFormat.formatToParts()` — the spec-guaranteed approach
 * for timezone-aware field extraction. Unlike the `toLocaleString` round-trip
 * (`new Date(d.toLocaleString("en-US", { timeZone }))`), this does not
 * depend on locale-specific date string formatting or parsing, and handles
 * DST transitions correctly (spring-forward gaps, fall-back overlaps).
 *
 * @param {Date}   date     - UTC Date object.
 * @param {string} timezone - IANA timezone name (e.g. "America/New_York").
 * @returns {{ minute: number, hour: number, day: number, month: number, weekday: number }}
 */
const _tzFormatters = new Map();

function getDatePartsInTz(date, timezone) {
  // Cache the DateTimeFormat instance per timezone — construction is expensive,
  // but formatToParts() on a cached instance is fast.
  let fmt = _tzFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    _tzFormatters.set(timezone, fmt);
  }

  const partsArr = fmt.formatToParts(date);
  const parts = {};
  for (const p of partsArr) parts[p.type] = p.value;

  // Map weekday short name → 0-6 (Sun=0)
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    minute:  parseInt(parts.minute, 10),
    hour:    parseInt(parts.hour, 10) % 24, // en-US hour12:false returns 24 for midnight in some engines
    day:     parseInt(parts.day, 10),
    month:   parseInt(parts.month, 10),
    weekday: dayMap[parts.weekday] ?? 0,
  };
}

/**
 * Compute the next fire time for a cron expression in a given timezone.
 * Returns an ISO 8601 string or null if the expression is invalid.
 *
 * We use a lightweight approach: advance minute-by-minute from now (max
 * 1 year) until the cron fields match.  For common schedules this resolves
 * in at most 525,960 steps, typically far fewer.  A real cron-parser
 * library would be cleaner but avoids a new dependency.
 *
 * Timezone conversion uses `Intl.DateTimeFormat.formatToParts()` — the
 * spec-guaranteed approach that correctly handles DST transitions.
 *
 * @param {string} cronExpr  - 5-field cron expression.
 * @param {string} [timezone] - IANA timezone (defaults to "UTC").
 * @returns {string|null}
 */
export function getNextRunAt(cronExpr, timezone = "UTC") {
  if (!cron.validate(cronExpr)) return null;

  // Parse cron fields: minute hour dom month dow
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = fields;

  /**
   * Check if a single atomic cron token matches the given value.
   * An atom is one of: "*", a plain number, a range "a-b", or any of
   * those followed by "/step".
   */
  function matchesAtom(atom, value, min, max) {
    // Step: */n, a-b/n, or plain/n
    if (atom.includes("/")) {
      const [range, step] = atom.split("/");
      const stepN = parseInt(step, 10);
      if (range === "*") return (value - min) % stepN === 0;
      if (range.includes("-")) {
        const [lo, hi] = range.split("-").map(Number);
        return value >= lo && value <= hi && (value - lo) % stepN === 0;
      }
      // plain start/step (e.g. "5/2") — start at lo, step through max
      const lo = parseInt(range, 10);
      return value >= lo && value <= max && (value - lo) % stepN === 0;
    }
    // Range: a-b
    if (atom.includes("-")) {
      const [lo, hi] = atom.split("-").map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(atom, 10) === value;
  }

  function matches(field, value, min, max) {
    if (field === "*") return true;
    // List: split on commas and delegate each element to matchesAtom
    // This correctly handles combined list+range like "1-5,10-15"
    if (field.includes(",")) {
      return field.split(",").some(atom => matchesAtom(atom, value, min, max));
    }
    return matchesAtom(field, value, min, max);
  }

  // ── Day-of-week Sunday alias: POSIX cron allows 7 as well as 0 ──────
  // getDatePartsInTz returns 0 for Sunday (JS convention: 0=Sun … 6=Sat).
  // When the cron field contains 7, we need to match it against value 0.
  //
  // Simple text replacement ("7"→"0") breaks ranges like "5-7" → "5-0"
  // (which would never match). Instead, we match the dow field twice:
  //   1. Match with the real weekday value (0–6) — handles 0-based fields.
  //   2. If Sunday (value=0), also try matching as value 7 — handles
  //      fields written with the 7-alias (plain "7", range "5-7", list "1,7").
  function matchesDow(field, value) {
    if (matches(field, value, 0, 7)) return true;
    // If today is Sunday (0), also check if the field matches 7
    if (value === 0 && matches(field, 7, 0, 7)) return true;
    return false;
  }

  // Start from the next full minute
  const start = new Date();
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000); // +1 minute

  // Iterate up to 1 year ahead
  const limit = start.getTime() + 365 * 24 * 60 * 60 * 1000;
  const candidate = new Date(start);

  while (candidate.getTime() < limit) {
    // Evaluate the candidate in the target timezone using Intl.DateTimeFormat
    const tp = getDatePartsInTz(candidate, timezone);

    if (
      matches(minuteField, tp.minute,  0, 59) &&
      matches(hourField,   tp.hour,    0, 23) &&
      matches(domField,    tp.day,     1, 31) &&
      matches(monthField,  tp.month,   1, 12) &&
      matchesDow(dowField, tp.weekday)
    ) {
      return candidate.toISOString();
    }
    candidate.setTime(candidate.getTime() + 60_000);
  }
  return null;
}

// ─── Fire a scheduled run ──────────────────────────────────────────────────────

/**
 * Execute a test run for a project as triggered by a cron schedule.
 * Mirrors the logic in `POST /api/projects/:id/run`.
 *
 * @param {string} projectId
 */
async function fireScheduledRun(projectId) {
  const project = projectRepo.getById(projectId);
  if (!project) {
    console.warn(formatLogLine("warn", null, `[scheduler] Project ${projectId} not found — skipping scheduled run`));
    return;
  }

  // Skip if an active run is already in progress
  const activeRun = runRepo.findActiveByProjectId(projectId);
  if (activeRun) {
    console.log(formatLogLine("info", null, `[scheduler] Skipping scheduled run for ${project.name} — ${activeRun.id} already running`));
    return;
  }

  const allTests = testRepo.getByProjectId(projectId);
  const tests = allTests.filter(t => t.reviewStatus === "approved");

  if (!tests.length) {
    console.log(formatLogLine("info", null, `[scheduler] Skipping scheduled run for ${project.name} — no approved tests`));
    return;
  }

  // Use the project's configured parallelWorkers (from last dials config),
  // falling back to the PARALLEL_WORKERS env var or 1 if not set.
  const defaultWorkers = parseInt(process.env.PARALLEL_WORKERS, 10) || 1;
  const parallelWorkers = Math.max(1, Math.min(10, defaultWorkers));

  const runId = generateRunId();
  const run = {
    id: runId,
    projectId: project.id,
    type: "test_run",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    results: [],
    passed: 0,
    failed: 0,
    total: tests.length,
    parallelWorkers,
    testQueue: tests.map(t => ({ id: t.id, name: t.name, steps: t.steps || [] })),
  };
  runRepo.create(run);

  logActivity({
    type: "scheduled_run.start",
    projectId: project.id,
    projectName: project.name,
    workspaceId: project.workspaceId || null,
    detail: `Scheduled test run started — ${tests.length} test${tests.length !== 1 ? "s" : ""}${parallelWorkers > 1 ? ` (${parallelWorkers}x parallel)` : ""}`,
    status: "running",
  });

  console.log(formatLogLine("info", null, `[scheduler] Firing scheduled run ${runId} for project ${project.name}`));

  runWithAbort(runId, run,
    signal => runTests(project, tests, run, { parallelWorkers, signal }),
    {
      onSuccess: () => {
        logActivity({
          type: "scheduled_run.complete",
          projectId: project.id,
          projectName: project.name,
          workspaceId: project.workspaceId || null,
          detail: `Scheduled run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
        });
      },
      onFailActivity: (err) => ({
        type: "scheduled_run.fail",
        projectId: project.id,
        projectName: project.name,
        workspaceId: project.workspaceId || null,
        detail: `Scheduled run failed: ${classifyError(err, "run").message}`,
      }),
      onComplete: async (finishedRun) => {
        // Record lastRunAt and update nextRunAt
        const schedule = scheduleRepo.getByProjectId(projectId);
        if (schedule) {
          const nextRunAt = getNextRunAt(schedule.cronExpr, schedule.timezone);
          scheduleRepo.updateRunTimes(projectId, new Date().toISOString(), nextRunAt);
        }
        // FEA-001: Fire failure notifications — best-effort
        try { await fireNotifications(finishedRun, project); } catch { /* best-effort */ }
      },
    },
  );
}

// ─── Task management ──────────────────────────────────────────────────────────

/**
 * Cancel and remove an existing task for a project (if any).
 * @param {string} projectId
 */
function cancelTask(projectId) {
  const existing = tasks.get(projectId);
  if (existing) {
    existing.stop();
    tasks.delete(projectId);
  }
}

/**
 * Arm (or re-arm) a cron task for a project schedule.
 * If the schedule is disabled or has an invalid cron expression, the task
 * is cancelled and removed.
 *
 * @param {Object} schedule - Schedule row from scheduleRepo
 */
function armTask(schedule) {
  cancelTask(schedule.projectId);

  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cronExpr)) {
    console.warn(formatLogLine("warn", null,
      `[scheduler] Invalid cron expression "${schedule.cronExpr}" for project ${schedule.projectId} — task not armed`));
    return;
  }

  const task = cron.schedule(schedule.cronExpr, () => {
    fireScheduledRun(schedule.projectId).catch(err => {
      console.error(formatLogLine("error", null,
        `[scheduler] Unhandled error in scheduled run for ${schedule.projectId}: ${err.message}`));
    });
  }, {
    timezone: schedule.timezone || "UTC",
    scheduled: true,
  });

  tasks.set(schedule.projectId, task);
  console.log(formatLogLine("info", null,
    `[scheduler] Armed task for project ${schedule.projectId} (${schedule.cronExpr}, tz=${schedule.timezone})`));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load all enabled schedules from the database and arm cron tasks.
 * Called once from `index.js` after DB init.
 */
export function initScheduler() {
  const schedules = scheduleRepo.getAllEnabled();
  for (const s of schedules) {
    try {
      armTask(s);
    } catch (err) {
      console.error(formatLogLine("error", null,
        `[scheduler] Failed to arm task for project ${s.projectId}: ${err.message} — skipping`));
    }
  }
  console.log(formatLogLine("info", null, `[scheduler] Initialised — ${tasks.size} active schedule(s) (${schedules.length} loaded)`));
}

/**
 * Reload a single project's cron task after a schedule create/update/toggle.
 * Fetches the latest schedule from the DB and re-arms the task.
 *
 * @param {string} projectId
 */
export function reloadSchedule(projectId) {
  const schedule = scheduleRepo.getByProjectId(projectId);
  if (!schedule) {
    cancelTask(projectId);
    return;
  }
  armTask(schedule);
}

/**
 * Stop and remove the task for a project.
 * Called when a project is deleted so the cron task doesn't fire against
 * a non-existent project.
 *
 * @param {string} projectId
 */
export function stopSchedule(projectId) {
  cancelTask(projectId);
}

/**
 * Stop and remove all active cron tasks.
 * Called during graceful shutdown so no new scheduled runs fire while
 * in-flight work is draining.
 */
export function stopAllTasks() {
  for (const [projectId, task] of tasks) {
    task.stop();
  }
  tasks.clear();
}

/**
 * Return the number of currently active (armed) cron tasks.
 * Exposed for the /api/system health endpoint.
 *
 * @returns {number}
 */
export function activeTaskCount() {
  return tasks.size;
}
