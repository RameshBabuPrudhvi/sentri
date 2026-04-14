/**
 * @module routes/recycleBin
 * @description Recycle-bin endpoints for soft-deleted entities. Mounted at `/api`.
 *
 * ### Endpoints
 * | Method   | Path                        | Description                                        |
 * |----------|-----------------------------|-----------------------------------------------------|
 * | `GET`    | `/api/recycle-bin`          | List all soft-deleted entities grouped by type     |
 * | `POST`   | `/api/restore/:type/:id`    | Restore a soft-deleted entity                      |
 * | `DELETE` | `/api/purge/:type/:id`      | Permanently delete a soft-deleted entity (purge)   |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import { logActivity } from "../utils/activityLogger.js";
import { actor } from "../utils/actor.js";
import { sanitiseProjectForClient } from "../utils/projectSanitiser.js";

const router = Router();

// ─── Recycle bin ─────────────────────────────────────────────────────────────

/**
 * GET /api/recycle-bin
 * Returns all soft-deleted entities grouped by type, newest first.
 */
router.get("/recycle-bin", (req, res) => {
  const projects = projectRepo.getDeletedAll().map(sanitiseProjectForClient);
  const tests    = testRepo.getDeletedAll();
  const runs     = runRepo.getDeletedAll();
  res.json({ projects, tests, runs });
});

/**
 * POST /api/restore/:type/:id
 * Restore a soft-deleted entity. type must be "project", "test", or "run".
 */
router.post("/restore/:type/:id", (req, res) => {
  const { type, id } = req.params;
  let restored = false;

  if (type === "project") {
    restored = projectRepo.restore(id);
    if (restored) {
      // Cascade-restore all tests and runs that belong to this project.
      testRepo.getDeletedByProjectId(id).forEach(t => testRepo.restore(t.id));
      runRepo.getDeletedByProjectId(id).forEach(r => runRepo.restore(r.id));
      const proj = projectRepo.getById(id);
      logActivity({ ...actor(req),
        type: "project.restore", projectId: id, projectName: proj?.name,
        detail: `Project "${proj?.name}" restored from recycle bin`,
      });
    }
  } else if (type === "test") {
    const test = testRepo.getByIdIncludeDeleted(id);
    if (test) {
      const parentProject = projectRepo.getById(test.projectId);
      if (!parentProject) {
        return res.status(409).json({ error: "Parent project is deleted — restore the project first" });
      }
    }
    restored = testRepo.restore(id);
    if (restored) {
      logActivity({ ...actor(req),
        type: "test.restore", testId: id, testName: test?.name,
        detail: `Test "${test?.name}" restored from recycle bin`,
      });
    }
  } else if (type === "run") {
    const run = runRepo.getByIdIncludeDeleted(id);
    if (run) {
      const parentProject = projectRepo.getById(run.projectId);
      if (!parentProject) {
        return res.status(409).json({ error: "Parent project is deleted — restore the project first" });
      }
    }
    restored = runRepo.restore(id);
    if (restored) {
      logActivity({ ...actor(req),
        type: "run.restore", detail: `Run ${id} restored from recycle bin`,
      });
    }
  } else {
    return res.status(400).json({ error: "type must be project, test, or run" });
  }

  if (!restored) return res.status(404).json({ error: "not found or not in recycle bin" });
  res.json({ ok: true });
});

/**
 * DELETE /api/purge/:type/:id
 * Permanently and irreversibly delete a soft-deleted entity.
 * type must be "project", "test", or "run".
 */
router.delete("/purge/:type/:id", (req, res) => {
  const { type, id } = req.params;

  if (type === "project") {
    const project = projectRepo.getByIdIncludeDeleted(id);
    if (!project || !project.deletedAt) {
      return res.status(404).json({ error: "not found in recycle bin" });
    }
    const testIds = testRepo.hardDeleteByProjectId(id);
    if (testIds.length > 0) healingRepo.deleteByTestIds(testIds);
    runRepo.hardDeleteByProjectId(id);
    activityRepo.deleteByProjectId(id);
    projectRepo.hardDeleteById(id);
    logActivity({ ...actor(req),
      type: "project.purge", projectId: id, projectName: project.name,
      detail: `Project "${project.name}" permanently purged`,
    });
  } else if (type === "test") {
    const test = testRepo.getByIdIncludeDeleted(id);
    if (!test || !test.deletedAt) {
      return res.status(404).json({ error: "not found in recycle bin" });
    }
    healingRepo.deleteByTestIds([id]);
    testRepo.hardDeleteById(id);
    logActivity({ ...actor(req),
      type: "test.purge", testId: id,
      detail: `Test "${test.name}" permanently purged`,
    });
  } else if (type === "run") {
    const run = runRepo.getByIdIncludeDeleted(id);
    if (!run || !run.deletedAt) {
      return res.status(404).json({ error: "not found in recycle bin" });
    }
    runRepo.hardDeleteById(id);
    logActivity({ ...actor(req),
      type: "run.purge", detail: `Run ${id} permanently purged`,
    });
  } else {
    return res.status(400).json({ error: "type must be project, test, or run" });
  }

  res.json({ ok: true });
});

export default router;
