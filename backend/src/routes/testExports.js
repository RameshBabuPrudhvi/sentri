/**
 * @module routes/testExports
 * @description Test export endpoints — enterprise test-management integration.
 * Mounted at `/api/v1` (INF-005). Extracted from `routes/tests.js` (MNT decomposition).
 *
 * All four routes are pure GETs over the `tests` table for a project. They
 * carry no `:testId` wildcards and therefore no route-ordering interaction
 * with the CRUD/review handlers in `routes/tests.js`.
 *
 * ### Endpoints
 * | Method | Path                                          | Description                              |
 * |--------|-----------------------------------------------|------------------------------------------|
 * | `GET`  | `/api/v1/projects/:id/tests/export/zephyr`    | Zephyr Scale CSV export                  |
 * | `GET`  | `/api/v1/projects/:id/tests/export/testrail`  | TestRail CSV export                      |
 * | `GET`  | `/api/v1/projects/:id/tests/traceability`     | Traceability matrix (issue → tests)      |
 * | `GET`  | `/api/v1/projects/:id/export/playwright`      | Approved-tests Playwright project ZIP    |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import { buildZephyrCsv, buildTestRailCsv, buildPlaywrightZip } from "../utils/exportFormats.js";
import { formatLogLine } from "../utils/logFormatter.js";

const router = Router();

// GET /api/projects/:id/tests/export/zephyr — Zephyr Scale CSV for test management import
router.get("/projects/:id/tests/export/zephyr", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = testRepo.getByProjectId(req.params.id);
  const status = req.query.status;
  const filtered = status ? tests.filter(t => t.reviewStatus === status) : tests;

  const csv = buildZephyrCsv(filtered);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="sentri-${project.name.replace(/[^a-z0-9]+/gi, "-")}-zephyr.csv"`);
  res.send(csv);
});

// GET /api/projects/:id/tests/export/testrail — TestRail CSV for bulk import
router.get("/projects/:id/tests/export/testrail", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = testRepo.getByProjectId(req.params.id);
  const status = req.query.status;
  const filtered = status ? tests.filter(t => t.reviewStatus === status) : tests;

  const csv = buildTestRailCsv(filtered);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="sentri-${project.name.replace(/[^a-z0-9]+/gi, "-")}-testrail.csv"`);
  res.send(csv);
});

// GET /api/projects/:id/export/playwright — runnable Playwright project ZIP (DIF-006)
//
// Note on access control: matches the convention used by every other route
// in this file — `getByIdInWorkspace` returns null for both "doesn't exist"
// and "not a workspace member", and we collapse both into 404 to avoid
// leaking project existence across workspace boundaries (ACL-001).
router.get("/projects/:id/export/playwright", async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  try {
    const allTests = testRepo.getByProjectId(req.params.id);
    const approvedTests = allTests.filter(t => t.reviewStatus === "approved");

    const zipBuffer = await buildPlaywrightZip(project, approvedTests);
    const safeProjectName = project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="sentri-${safeProjectName}-playwright.zip"`);
    res.send(zipBuffer);
  } catch (err) {
    // Async route handlers in Express 4 do NOT auto-catch rejected promises;
    // without this try/catch the request hangs indefinitely on any failure
    // (e.g. system `zip` binary missing). Match the error-handling style of
    // the recorder and PATCH handlers above — log internally, return generic.
    console.error(formatLogLine("error", null, `[GET projects/${req.params.id}/export/playwright] export failed: ${err.message}`));
    // ZIP_BINARY_MISSING is an operator-fixable deployment issue, not an
    // internal bug — surface it as 503 with the actionable message so the
    // user can install `zip` or switch to a base image that ships it.
    // Every other failure stays a generic 500 (no internal detail leaked).
    if (err.code === "ZIP_BINARY_MISSING") {
      return res.status(503).json({
        error: "Playwright export unavailable: system `zip` binary not installed on this deployment.",
        code: "ZIP_BINARY_MISSING",
        hint: "Install `zip` on the backend host (apt-get install zip / apk add zip) or use a Docker image that ships it.",
      });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/projects/:id/tests/traceability — traceability matrix (requirement → test → result)
router.get("/projects/:id/tests/traceability", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = testRepo.getByProjectId(req.params.id);

  // Group tests by linked issue key
  const byIssue = {};
  const unlinked = [];
  for (const t of tests) {
    const entry = {
      testId: t.id,
      name: t.name,
      type: t.type,
      priority: t.priority,
      scenario: t.scenario,
      reviewStatus: t.reviewStatus,
      lastResult: t.lastResult,
      lastRunAt: t.lastRunAt,
      promptVersion: t.promptVersion,
      tags: t.tags || [],
    };
    if (t.linkedIssueKey) {
      if (!byIssue[t.linkedIssueKey]) byIssue[t.linkedIssueKey] = [];
      byIssue[t.linkedIssueKey].push(entry);
    } else {
      unlinked.push(entry);
    }
  }

  res.json({
    projectId: project.id,
    projectName: project.name,
    totalTests: tests.length,
    linkedIssues: Object.keys(byIssue).length,
    unlinkedTests: unlinked.length,
    matrix: byIssue,
    unlinked,
  });
});

export default router;
