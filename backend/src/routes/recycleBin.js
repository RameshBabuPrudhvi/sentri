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
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import * as scheduleRepo from "../database/repositories/scheduleRepo.js";
import { stopSchedule } from "../scheduler.js";
import { logActivity } from "../utils/activityLogger.js";
import { actor } from "../utils/actor.js";
import { sanitiseProjectForClient } from "../utils/projectSanitiser.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

// ─── Recycle bin ─────────────────────────────────────────────────────────────

/**
 * GET /api/recycle-bin
 * Returns all soft-deleted entities grouped by type, newest first.
 * Capped at 200 items per type to prevent unbounded responses.
 */
router.get("/recycle-bin", (req, res) => {
  const LIMIT = 200;
  // ACL-001: Scope recycle bin to the user's workspace.
  const projects = projectRepo.getDeletedAll(req.workspaceId).slice(0, LIMIT).map(sanitiseProjectForClient);
  const deletedProjectIds = new Set(projects.map(p => p.id));
  // Also include project IDs from live projects in this workspace so we can
  // show deleted tests/runs that belong to non-deleted workspace projects.
  const liveProjects = projectRepo.getAll(req.workspaceId);
  const allProjectIds = new Set([...deletedProjectIds, ...liveProjects.map(p => p.id)]);
  const tests    = testRepo.getDeletedAll().filter(t => allProjectIds.has(t.projectId)).slice(0, LIMIT);
  const runs     = runRepo.getDeletedAll().filter(r => allProjectIds.has(r.projectId)).slice(0, LIMIT);
  res.json({ projects, tests, runs });
});

/**
 * POST /api/restore/:type/:id
 * Restore a soft-deleted entity. type must be "project", "test", or "run".
 */
router.post("/restore/:type/:id", requireRole("qa_lead"), (req, res) => {
  const { type, id } = req.params;
  let restored = false;

  if (type === "project") {
    // ACL-001: Verify the project belongs to the user's workspace.
    const projectBefore = projectRepo.getByIdIncludeDeleted(id);
    if (!projectBefore || projectBefore.workspaceId !== req.workspaceId) {
      return res.status(404).json({ error: "not found or not in recycle bin" });
    }
    // Capture the project's deletedAt before restoring so we can scope the
    // cascade to only children deleted at the same time (or later).  Items
    // individually deleted *before* the project are left in the recycle bin.
    restored = projectRepo.restore(id);
    if (restored) {
      const deletedAt = projectBefore?.deletedAt;
      if (deletedAt) {
        testRepo.restoreByProjectIdAfter(id, deletedAt);
        runRepo.restoreByProjectIdAfter(id, deletedAt);
      }
      const proj = projectRepo.getById(id);
      logActivity({ ...actor(req),
        type: "project.restore", projectId: id, projectName: proj?.name,
        detail: `Project "${proj?.name}" restored from recycle bin`,
      });
    }
  } else if (type === "test") {
    const test = testRepo.getByIdIncludeDeleted(id);
    if (test) {
      // ACL-001: Verify the test's project belongs to the user's workspace.
      const parentProjectFull = projectRepo.getByIdIncludeDeleted(test.projectId);
      if (!parentProjectFull || parentProjectFull.workspaceId !== req.workspaceId) {
        return res.status(404).json({ error: "not found or not in recycle bin" });
      }
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
      // ACL-001: Verify the run's project belongs to the user's workspace.
      const parentProjectFull = projectRepo.getByIdIncludeDeleted(run.projectId);
      if (!parentProjectFull || parentProjectFull.workspaceId !== req.workspaceId) {
        return res.status(404).json({ error: "not found or not in recycle bin" });
      }
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
router.delete("/purge/:type/:id", requireRole("admin"), (req, res) => {
  const { type, id } = req.params;

  if (type === "project") {
    const project = projectRepo.getByIdIncludeDeleted(id);
    if (!project || !project.deletedAt) {
      return res.status(404).json({ error: "not found in recycle bin" });
    }
    // ACL-001: Verify the project belongs to the user's workspace.
    if (project.workspaceId !== req.workspaceId) {
      return res.status(404).json({ error: "not found in recycle bin" });
    }
    const testIds = testRepo.hardDeleteByProjectId(id);
    if (testIds.length > 0) healingRepo.deleteByTestIds(testIds);
    runRepo.hardDeleteByProjectId(id);
    activityRepo.deleteByProjectId(id);
    webhookTokenRepo.deleteByProjectId(id);
    scheduleRepo.deleteByProjectId(id);
    stopSchedule(id);
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
    // ACL-001: Verify the test's project belongs to the user's workspace.
    const testProject = projectRepo.getByIdIncludeDeleted(test.projectId);
    if (!testProject || testProject.workspaceId !== req.workspaceId) {
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
    // ACL-001: Verify the run's project belongs to the user's workspace.
    const runProject = projectRepo.getByIdIncludeDeleted(run.projectId);
    if (!runProject || runProject.workspaceId !== req.workspaceId) {
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
