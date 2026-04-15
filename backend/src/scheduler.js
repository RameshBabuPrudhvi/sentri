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
import { formatLogLine } from "./utils/logFormatter.js";

// ─── Task registry ─────────────────────────────────────────────────────────────
// Maps projectId → node-cron ScheduledTask
/** @type {Map<string, Object>} projectId → node-cron ScheduledTask */
const tasks = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute the next fire time for a cron expression in a given timezone.
 * Returns an ISO 8601 string or null if the expression is invalid.
 *
 * We use a lightweight approach: advance minute-by-minute from now (max
 * 1 year) until cron.validate passes for the expression.  For common
 * schedules this resolves in at most 525,960 steps, typically far fewer.
 * A real cron-parser library would be cleaner but avoids a new dependency.
 *
 * @param {string} cronExpr  - 5-field cron expression.
 * @param {string} [timezone] - IANA timezone (defaults to "UTC").
 * @returns {string|null}
 */
export function getNextRunAt(cronExpr, timezone = "UTC") {
  if (!cron.validate(cronExpr)) return null;

  // Parse cron fields: minute hour dom month dow
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = parts;

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

  // Start from the next full minute
  const start = new Date();
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000); // +1 minute

  // Iterate up to 1 year ahead
  const limit = start.getTime() + 365 * 24 * 60 * 60 * 1000;
  const candidate = new Date(start);

  while (candidate.getTime() < limit) {
    // Evaluate the candidate in the target timezone
    const tzDate = new Date(candidate.toLocaleString("en-US", { timeZone: timezone }));
    const min   = tzDate.getMinutes();
    const hour  = tzDate.getHours();
    const dom   = tzDate.getDate();
    const month = tzDate.getMonth() + 1; // 1-based
    const dow   = tzDate.getDay();       // 0=Sun

    if (
      matches(minuteField, min,   0, 59) &&
      matches(hourField,   hour,  0, 23) &&
      matches(domField,    dom,   1, 31) &&
      matches(monthField,  month, 1, 12) &&
      matches(dowField,    dow,   0,  6)
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
    parallelWorkers: 1,
    testQueue: tests.map(t => ({ id: t.id, name: t.name, steps: t.steps || [] })),
  };
  runRepo.create(run);

  logActivity({
    type: "scheduled_run.start",
    projectId: project.id,
    projectName: project.name,
    detail: `Scheduled test run started — ${tests.length} test${tests.length !== 1 ? "s" : ""}`,
    status: "running",
  });

  console.log(formatLogLine("info", null, `[scheduler] Firing scheduled run ${runId} for project ${project.name}`));

  runWithAbort(runId, run,
    signal => runTests(project, tests, run, { parallelWorkers: 1, signal }),
    {
      onSuccess: () => {
        logActivity({
          type: "scheduled_run.complete",
          projectId: project.id,
          projectName: project.name,
          detail: `Scheduled run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
        });
      },
      onFailActivity: () => ({
        type: "scheduled_run.fail",
        projectId: project.id,
        projectName: project.name,
        detail: `Scheduled run failed`,
      }),
      onComplete: () => {
        // Record lastRunAt and update nextRunAt
        const schedule = scheduleRepo.getByProjectId(projectId);
        if (schedule) {
          const nextRunAt = getNextRunAt(schedule.cronExpr, schedule.timezone);
          scheduleRepo.updateRunTimes(projectId, new Date().toISOString(), nextRunAt);
        }
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
 * Return the number of currently active (armed) cron tasks.
 * Exposed for the /api/system health endpoint.
 *
 * @returns {number}
 */
export function activeTaskCount() {
  return tasks.size;
}
