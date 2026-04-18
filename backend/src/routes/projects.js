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
 * | `GET`    | `/api/projects/:id/notifications` | Get notification settings for a project          |
 * | `PATCH`  | `/api/projects/:id/notifications` | Create or update notification settings            |
 * | `DELETE` | `/api/projects/:id/notifications` | Remove notification settings for a project        |
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
import { requireRole } from "../middleware/requireRole.js";
import * as notificationSettingsRepo from "../database/repositories/notificationSettingsRepo.js";
import { generateNotificationSettingId } from "../utils/idGenerator.js";
import { validateUrl } from "../utils/ssrfGuard.js";
import cron from "node-cron";

const router = Router();

// ─── Project CRUD ─────────────────────────────────────────────────────────────

router.post("/", requireRole("qa_lead"), (req, res) => {
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
    workspaceId: req.workspaceId || null,
  };
  projectRepo.create(project);

  logActivity({ ...actor(req),
    type: "project.create", projectId: id, projectName: name,
    detail: `Project created — "${name}" (${url})`,
  });

  res.status(201).json(sanitiseProjectForClient(project));
});

router.get("/", (req, res) => {
  res.json(projectRepo.getAll(req.workspaceId).map(sanitiseProjectForClient));
});

router.get("/:id", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(sanitiseProjectForClient(project));
});

router.delete("/:id", requireRole("admin"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });

  // Refuse soft-deletion while async operations are in progress
  const activeRun = runRepo.findActiveByProjectId(req.params.id);
  if (activeRun) {
    return res.status(409).json({
      error: "Cannot delete project while operations are running. Wait for active crawls or test runs to complete.",
    });
  }

  // Check for automation config that will be permanently destroyed (not recoverable
  // via restore) so the response can inform the frontend for a user-facing warning.
  const existingTokens  = webhookTokenRepo.getByProjectId(req.params.id);
  const existingSchedule = scheduleRepo.getByProjectId(req.params.id);

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
    // Restoring the project will NOT restore these — CI pipelines will need
    // new tokens.
    webhookTokenRepo.deleteByProjectId(req.params.id);
    // Stop any armed cron task so the scheduler doesn't keep firing for a
    // soft-deleted project (which would log repeated warnings every interval).
    // Restoring the project will NOT restore the schedule — it must be
    // reconfigured manually.
    scheduleRepo.deleteByProjectId(req.params.id);
  })();
  stopSchedule(req.params.id);

  logActivity({ ...actor(req),
    type: "project.delete", projectId: req.params.id, projectName: project.name,
    detail: `Project soft-deleted — "${project.name}" (${testIds.length} tests, ${runIds.length} runs moved to recycle bin)`,
  });

  res.json({
    ok: true,
    deletedTests: testIds.length,
    deletedRuns: runIds.length,
    // Inform the client about permanently destroyed automation config so the
    // frontend can display a warning (these are NOT restored on project restore).
    destroyedTokens: existingTokens.length,
    destroyedSchedule: !!existingSchedule,
  });
});

// ─── Schedule endpoints ───────────────────────────────────────────────────────

/**
 * GET /api/projects/:id/schedule
 * Return the current schedule for a project, or null if none exists.
 */
router.get("/:id/schedule", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
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
router.patch("/:id/schedule", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
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
router.delete("/:id/schedule", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
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

// ─── Notification settings endpoints (FEA-001) ───────────────────────────────

/**
 * GET /api/projects/:id/notifications
 * Return the notification settings for a project, or null if none exist.
 */
router.get("/:id/notifications", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const settings = notificationSettingsRepo.getByProjectId(req.params.id);
  res.json({ notifications: settings || null });
});

/**
 * PATCH /api/projects/:id/notifications
 * Create or update notification settings for a project.
 *
 * Body:
 *   teamsWebhookUrl  {string}  - Microsoft Teams incoming webhook URL (optional)
 *   emailRecipients  {string}  - Comma-separated email addresses (optional)
 *   webhookUrl       {string}  - Generic webhook URL (optional)
 *   enabled          {boolean} - Whether notifications are active (default true)
 */
router.patch("/:id/notifications", requireRole("qa_lead"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { teamsWebhookUrl, emailRecipients, webhookUrl, enabled = true } = req.body || {};

  // Validate at least one channel is configured
  const hasTeams = typeof teamsWebhookUrl === "string" && teamsWebhookUrl.trim();
  const hasEmail = typeof emailRecipients === "string" && emailRecipients.trim();
  const hasWebhook = typeof webhookUrl === "string" && webhookUrl.trim();

  if (!hasTeams && !hasEmail && !hasWebhook) {
    return res.status(400).json({ error: "At least one notification channel must be configured (teamsWebhookUrl, emailRecipients, or webhookUrl)" });
  }

  // SSRF-safe URL validation for webhook URLs (protocol, private hosts, DNS resolution)
  if (hasTeams) {
    const teamsErr = await validateUrl(teamsWebhookUrl);
    if (teamsErr) return res.status(400).json({ error: `teamsWebhookUrl: ${teamsErr}` });
  }
  if (hasWebhook) {
    const webhookErr = await validateUrl(webhookUrl);
    if (webhookErr) return res.status(400).json({ error: `webhookUrl: ${webhookErr}` });
  }

  // Validate email format (basic check)
  if (hasEmail) {
    const emails = emailRecipients.split(",").map(e => e.trim()).filter(Boolean);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of emails) {
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: `Invalid email address: "${email}"` });
      }
    }
  }

  const existing = notificationSettingsRepo.getByProjectId(req.params.id);
  const now = new Date().toISOString();

  const settings = notificationSettingsRepo.upsert({
    id: existing?.id || generateNotificationSettingId(),
    projectId: req.params.id,
    teamsWebhookUrl: hasTeams ? teamsWebhookUrl.trim() : null,
    emailRecipients: hasEmail ? emailRecipients.trim() : null,
    webhookUrl: hasWebhook ? webhookUrl.trim() : null,
    enabled: Boolean(enabled),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });

  logActivity({
    ...actor(req),
    type: "notifications.update",
    projectId: project.id,
    projectName: project.name,
    detail: `Notification settings ${existing ? "updated" : "created"}`,
  });

  res.json({ ok: true, notifications: settings });
});

/**
 * DELETE /api/projects/:id/notifications
 * Remove notification settings for a project.
 */
router.delete("/:id/notifications", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const existing = notificationSettingsRepo.getByProjectId(req.params.id);
  if (!existing) return res.status(404).json({ error: "No notification settings found for this project" });

  notificationSettingsRepo.deleteByProjectId(req.params.id);

  logActivity({
    ...actor(req),
    type: "notifications.delete",
    projectId: project.id,
    projectName: project.name,
    detail: "Notification settings removed",
  });

  res.json({ ok: true });
});

export default router;
