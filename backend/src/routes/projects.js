/**
 * @module routes/projects
 * @description Project CRUD routes. Mounted at `/api/projects`.
 *
 * ### Endpoints
 * | Method   | Path                | Description                                     |
 * |----------|---------------------|-------------------------------------------------|
 * | `POST`   | `/api/projects`     | Create a project                                |
 * | `GET`    | `/api/projects`     | List all projects                               |
 * | `GET`    | `/api/projects/:id` | Get a single project                            |
 * | `DELETE` | `/api/projects/:id` | Delete project + all tests, runs, and history   |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import { generateProjectId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { encryptCredentials } from "../utils/credentialEncryption.js";
import { validateProjectPayload, sanitise } from "../utils/validate.js";
import { actor } from "../utils/actor.js";

const router = Router();

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

/**
 * Strip encrypted credential values from a project before sending to the client.
 * Only returns whether auth is configured, not the actual secrets.
 * @param {Object} project
 * @returns {Object}
 * @private
 */
function sanitiseProjectForClient(project) {
  if (!project) return project;
  const { credentials, ...rest } = project;
  return {
    ...rest,
    credentials: credentials ? {
      usernameSelector: credentials.usernameSelector || "",
      passwordSelector: credentials.passwordSelector || "",
      submitSelector: credentials.submitSelector || "",
      _hasAuth: true,
    } : null,
  };
}

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

  // Refuse deletion while async operations are in progress to prevent orphaned data
  const activeRun = runRepo.findActiveByProjectId(req.params.id);
  if (activeRun) {
    return res.status(409).json({
      error: "Cannot delete project while operations are running. Wait for active crawls or test runs to complete.",
    });
  }

  // Delete associated tests and their healing history
  const testIds = testRepo.deleteByProjectId(req.params.id);
  if (testIds.length > 0) {
    healingRepo.deleteByTestIds(testIds);
  }

  // Delete associated runs
  const runIds = runRepo.deleteByProjectId(req.params.id);

  // Delete associated activities
  activityRepo.deleteByProjectId(req.params.id);

  // Delete the project itself
  projectRepo.deleteById(req.params.id);

  logActivity({ ...actor(req),
    type: "project.delete", projectId: req.params.id, projectName: project.name,
    detail: `Project deleted — "${project.name}" (${testIds.length} tests, ${runIds.length} runs removed)`,
  });

  res.json({ ok: true, deletedTests: testIds.length, deletedRuns: runIds.length });
});

export default router;
