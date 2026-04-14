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
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import { getDatabase } from "../database/sqlite.js";
import { generateProjectId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { encryptCredentials } from "../utils/credentialEncryption.js";
import { validateProjectPayload, sanitise } from "../utils/validate.js";
import { actor } from "../utils/actor.js";
import { sanitiseProjectForClient } from "../utils/projectSanitiser.js";

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
  })();

  logActivity({ ...actor(req),
    type: "project.delete", projectId: req.params.id, projectName: project.name,
    detail: `Project soft-deleted — "${project.name}" (${testIds.length} tests, ${runIds.length} runs moved to recycle bin)`,
  });

  res.json({ ok: true, deletedTests: testIds.length, deletedRuns: runIds.length });
});

export default router;
