/**
 * @module routes/projects
 * @description Project CRUD routes. Mounted at `/api/projects`.
 *
 * ### Endpoints
 * | Method   | Path                         | Description                                            |
 * |----------|------------------------------|--------------------------------------------------------|
 * | `POST`   | `/api/projects`              | Create a project                                       |
 * | `GET`    | `/api/projects`              | List all non-deleted projects                          |
 * | `GET`    | `/api/projects/:id`          | Get a single project                                   |
 * | `DELETE` | `/api/projects/:id`          | Soft-delete project + cascade soft-delete its data     |
 * | `GET`    | `/api/projects/:id/schedule` | Get the cron schedule for a project                    |
 * | `PATCH`  | `/api/projects/:id/schedule` | Create or update the cron schedule for a project       |
 * | `DELETE` | `/api/projects/:id/schedule` | Remove the cron schedule for a project                 |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import * as scheduleRepo from "../database/repositories/scheduleRepo.js";
import { getDatabase } from "../database/sqlite.js";
import { generateProjectId, generateScheduleId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { encryptCredentials } from "../utils/credentialEncryption.js";
import { validateProjectPayload, sanitise } from "../utils/validate.js";
import { actor } from "../utils/actor.js";
import { sanitiseProjectForClient } from "../utils/projectSanitiser.js";
import { reloadSchedule, stopSchedule, getNextRunAt } from "../scheduler.js";
import cron from "node-cron";

const router = Router();

// ─── Project CRUD ─────────────────────────────────────────────────────────────

router.post("/", (req, res) => {
  const validationErr = validateProjectPayload(req.body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const name = sanitise(req.body.name, 200);
  const url = req.body.url?.trim() || "";
  const credentials = req.body.credentials;

  const id = generateProjectId();
  const project = {
    id,
    name,
    url,
    credentials: encryptCredentials(credentials) || null,
    createdAt: new Date().toISOString(),
    status: "idle",
  };
  projectRepo.create(project);

  logActivity({ ...actor(req),
    type: "project.create", projectId: id, projectName: name,
    detail: `Project created — "${name}" (${url})`,
  });

  res.status(201).json(sanitiseProjectForClient(project));
});

router.get("/", (req, res) => {
  res.json(projectRepo.getAll().map(sanitiseProjectForClient));
});

router.get("/:id", (req, res) => {
  const project = projectRepo.getById(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(sanitiseProjectForClient(project));
});

router.delete("/:id", (req, res) => {
  const project = projectRepo.getById(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });

  // Refuse soft-deletion while async operations are in progress
  const activeRun = runRepo.findActiveByProjectId(req.params.id);
  if (activeRun) {
    return res.status(409).json({
      error: "Cannot delete project while operations are running. Wait for active crawls or test runs to complete.",
    });
  }

  // Wrap the cascade soft-delete in a transaction so all three tables get the
  // same `datetime('now')` value.  This guarantees the cascade-restore in
  // recycleBin.js (which uses `deletedAt >= project.deletedAt`) never misses
  // children due to a second-boundary crossing between separate statements.
  const db = getDatabase();
  let testIds, runIds;
  db.transaction(() => {
    projectRepo.deleteById(req.params.id);
    testIds = testRepo.deleteByProjectId(req.params.id);
    runIds  = runRepo.deleteByProjectId(req.params.id);
    // Trigger tokens are not soft-deleted — they are always hard-deleted
    // immediately since they are security credentials, not recoverable data.
    webhookTokenRepo.deleteByProjectId(req.params.id);
    // Stop any armed cron task so the scheduler doesn't keep firing for a
    // soft-deleted project (which would log repeated warnings every interval).
    scheduleRepo.deleteByProjectId(req.params.id);
  })();
  stopSchedule(req.params.id);

  logActivity({ ...actor(req),
    type: "project.delete", projectId: req.params.id, projectName: project.name,
    detail: `Project soft-deleted — "${project.name}" (${testIds.length} tests, ${runIds.length} runs moved to recycle bin)`,
  });

  res.json({ ok: true, deletedTests: testIds.length, deletedRuns: runIds.length });
});

export default router;

// ─── Schedule endpoints ───────────────────────────────────────────────────────

/**
 * GET /api/projects/:id/schedule
 * Return the current schedule for a project, or null if none exists.
 */
router.get("/:id/schedule", (req, res) => {
  const project = projectRepo.getById(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const schedule = scheduleRepo.getByProjectId(req.params.id);
  res.json({ schedule: schedule || null });
});

/**
 * PATCH /api/projects/:id/schedule
 * Create or update the cron schedule for a project.
 *
 * Body:
 *   cronExpr {string}  - 5-field cron expression (required)
 *   timezone {string}  - IANA timezone name (default "UTC")
 *   enabled  {boolean} - Whether the schedule is active (default true)
 */
router.patch("/:id/schedule", (req, res) => {
  const project = projectRepo.getById(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { cronExpr, timezone = "UTC", enabled = true } = req.body || {};

  if (!cronExpr || typeof cronExpr !== "string") {
    return res.status(400).json({ error: "cronExpr is required" });
  }
  if (!cron.validate(cronExpr)) {
    return res.status(400).json({ error: `Invalid cron expression: "${cronExpr}"` });
  }
  // Reject expressions with seconds field (6-part) — node-cron supports it
  // but we only expose the standard 5-field format to users.
  if (cronExpr.trim().split(/\s+/).length !== 5) {
    return res.status(400).json({ error: "cronExpr must be a standard 5-field expression (minute hour dom month dow)" });
  }

  // Validate timezone — an invalid IANA name would throw a RangeError in
  // toLocaleString (used by getNextRunAt) and crash with a 500.
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    return res.status(400).json({ error: `Invalid timezone: "${timezone}"` });
  }

  const existing = scheduleRepo.getByProjectId(req.params.id);
  const now = new Date().toISOString();
  const nextRunAt = getNextRunAt(cronExpr, timezone);

  const schedule = scheduleRepo.upsert({
    id: existing?.id || generateScheduleId(),
    projectId: req.params.id,
    cronExpr,
    timezone,
    enabled: Boolean(enabled),
    lastRunAt: existing?.lastRunAt || null,
    nextRunAt,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });

  // Hot-reload the cron task without a restart
  reloadSchedule(req.params.id);

  logActivity({
    ...actor(req),
    type: "schedule.update",
    projectId: project.id,
    projectName: project.name,
    detail: `Schedule ${existing ? "updated" : "created"} — ${cronExpr} (${timezone})`,
  });

  res.json({ ok: true, schedule });
});

/**
 * DELETE /api/projects/:id/schedule
 * Remove the cron schedule for a project entirely.
 */
router.delete("/:id/schedule", (req, res) => {
  const project = projectRepo.getById(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const existing = scheduleRepo.getByProjectId(req.params.id);
  if (!existing) return res.status(404).json({ error: "No schedule found for this project" });

  scheduleRepo.deleteByProjectId(req.params.id);
  stopSchedule(req.params.id);

  logActivity({
    ...actor(req),
    type: "schedule.delete",
    projectId: project.id,
    projectName: project.name,
    detail: `Schedule removed`,
  });

  res.json({ ok: true });
});
