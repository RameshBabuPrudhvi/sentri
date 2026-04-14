/**
 * @module routes/trigger
 * @description CI/CD webhook trigger routes (ENH-011). Mounted at `/api` without
 * `requireAuth` — this router handles its own token-based authentication so
 * CI pipelines can call it with a per-project Bearer token rather than a user JWT.
 *
 * ### Endpoints
 * | Method   | Path                                     | Auth              | Description                        |
 * |----------|------------------------------------------|-------------------|------------------------------------|
 * | `POST`   | `/api/projects/:id/trigger`              | Bearer token      | Start a CI/CD test run             |
 * | `GET`    | `/api/projects/:id/trigger-tokens`       | JWT (requireAuth) | List tokens — see runs.js          |
 * | `POST`   | `/api/projects/:id/trigger-tokens`       | JWT (requireAuth) | Create token — see runs.js         |
 * | `DELETE` | `/api/projects/:id/trigger-tokens/:tid`  | JWT (requireAuth) | Revoke token — see runs.js         |
 *
 * Token management endpoints (list/create/delete) live in `runs.js` and are
 * protected by `requireAuth`.  Only `POST /trigger` is here, unprotected.
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import { generateRunId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { runWithAbort } from "../utils/runWithAbort.js";
import { resolveDialsConfig } from "../testDials.js";
import { runTests } from "../testRunner.js";
import { classifyError } from "../utils/errorClassifier.js";
import { expensiveOpLimiter } from "../middleware/appSetup.js";

const router = Router();

/**
 * POST /api/projects/:id/trigger
 * Token-authenticated endpoint for CI/CD pipelines (ENH-011).
 *
 * ### Authentication
 * Pass the project trigger token as a Bearer token:
 * ```
 * Authorization: Bearer <plaintext-token>
 * ```
 * This endpoint does NOT accept JWTs — only tokens created via
 * `POST /api/projects/:id/trigger-tokens`.
 *
 * ### Request body (all fields optional)
 * ```json
 * {
 *   "callbackUrl":  "https://ci.example.com/hooks/sentri",
 *   "dialsConfig":  { "parallelWorkers": 2 }
 * }
 * ```
 *
 * ### Response `202 Accepted`
 * ```json
 * { "runId": "RUN-42", "statusUrl": "https://sentri.example.com/api/runs/RUN-42" }
 * ```
 * Poll `statusUrl` until `status` is no longer `"running"`.
 *
 * ### Error responses
 * | Code | Reason                                         |
 * |------|------------------------------------------------|
 * | 400  | No approved tests                              |
 * | 401  | Missing or invalid Bearer token                |
 * | 403  | Token belongs to a different project           |
 * | 404  | Project not found                              |
 * | 409  | Another run already in progress                |
 * | 429  | Rate limit exceeded (expensiveOpLimiter)       |
 *
 * @param {import("express").Request}  req
 * @param {import("express").Response} res
 */
router.post("/projects/:id/trigger", expensiveOpLimiter, async (req, res) => {
  // ── 1. Authenticate with trigger token ──────────────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authorization: Bearer <token> header required." });
  }
  const plaintext = authHeader.slice(7).trim();
  if (!plaintext) {
    return res.status(401).json({ error: "Empty token." });
  }

  const tokenRow = webhookTokenRepo.findByHash(webhookTokenRepo.hashToken(plaintext));
  if (!tokenRow) {
    return res.status(401).json({ error: "Invalid trigger token." });
  }

  // ── 2. Resolve project ────────────────────────────────────────────────
  const project = projectRepo.getById(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });

  // Ensure the token belongs to this project (prevent cross-project misuse)
  if (tokenRow.projectId !== project.id) {
    return res.status(403).json({ error: "Token does not belong to this project." });
  }

  // ── 3. Guard: no concurrent run ───────────────────────────────────────
  const existingRun = runRepo.findActiveByProjectId(project.id);
  if (existingRun) {
    return res.status(409).json({
      error: `A run is already in progress (${existingRun.id}).`,
      runId: existingRun.id,
    });
  }

  // ── 4. Guard: approved tests must exist ──────────────────────────────
  const allTests = testRepo.getByProjectId(project.id);
  const tests = allTests.filter((t) => t.reviewStatus === "approved");
  if (!allTests.length) {
    return res.status(400).json({ error: "No tests found — crawl first." });
  }
  if (!tests.length) {
    return res.status(400).json({ error: "No approved tests — review generated tests before triggering." });
  }

  // ── 5. Extract optional config ───────────────────────────────────────
  const { dialsConfig, callbackUrl } = req.body || {};
  const validatedDials = resolveDialsConfig(dialsConfig);
  const parallelWorkers = validatedDials?.parallelWorkers ?? 1;

  // ── 6. Create and start the run ──────────────────────────────────────
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
    testQueue: tests.map((t) => ({ id: t.id, name: t.name, steps: t.steps || [] })),
  };
  runRepo.create(run);

  // Record that this token was used (updates lastUsedAt)
  webhookTokenRepo.touch(tokenRow.id);

  logActivity({
    type: "test_run.start",
    projectId: project.id,
    projectName: project.name,
    detail: `CI/CD triggered test run — ${tests.length} test${tests.length !== 1 ? "s" : ""}${parallelWorkers > 1 ? ` (${parallelWorkers}x parallel)` : ""}`,
    status: "running",
  });

  runWithAbort(runId, run,
    (signal) => runTests(project, tests, run, { parallelWorkers, signal }),
    {
      onSuccess: () => {
        logActivity({
          type: "test_run.complete",
          projectId: project.id,
          projectName: project.name,
          detail: `CI/CD run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
        });
        // Fire optional callback URL with run summary (best-effort)
        if (callbackUrl && typeof callbackUrl === "string") {
          const body = JSON.stringify({
            runId,
            status: run.status,
            passed: run.passed,
            failed: run.failed,
            total: run.total,
          });
          fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(10_000),
          }).catch(() => { /* best-effort — never fails the run */ });
        }
      },
      onFailActivity: (err) => ({
        type: "test_run.fail",
        projectId: project.id,
        projectName: project.name,
        detail: `CI/CD run failed: ${classifyError(err, "run").message}`,
      }),
    },
  );

  // ── 7. Return 202 immediately — client polls statusUrl ───────────────
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  const statusUrl = `${proto}://${host}/api/runs/${runId}`;

  res.status(202).json({ runId, statusUrl });
});

export default router;
