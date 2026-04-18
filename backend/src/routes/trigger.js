/**
 * @module routes/trigger
 * @description CI/CD webhook trigger routes (ENH-011). Mounted at `/api/v1` (INF-005)
 * without `requireAuth` — this router handles its own token-based authentication so
 * CI pipelines can call it with a per-project Bearer token rather than a user JWT.
 *
 * ### Endpoints
 * | Method   | Path                                        | Auth              | Description                        |
 * |----------|---------------------------------------------|-------------------|------------------------------------|
 * | `POST`   | `/api/v1/projects/:id/trigger`              | Bearer token      | Start a CI/CD test run             |
 * | `GET`    | `/api/v1/projects/:id/trigger-tokens`       | JWT (requireAuth) | List tokens — see runs.js          |
 * | `POST`   | `/api/v1/projects/:id/trigger-tokens`       | JWT (requireAuth) | Create token — see runs.js         |
 * | `DELETE` | `/api/v1/projects/:id/trigger-tokens/:tid`  | JWT (requireAuth) | Revoke token — see runs.js         |
 *
 * Token management endpoints (list/create/delete) live in `runs.js` and are
 * protected by `requireAuth`.  Only `POST /trigger` is here, unprotected.
 */

import { Router } from "express";
import * as runRepo from "../database/repositories/runRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import { generateRunId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { runWithAbort } from "../utils/runWithAbort.js";
import { resolveDialsConfig } from "../testDials.js";
import { runTests } from "../testRunner.js";
import { classifyError } from "../utils/errorClassifier.js";
import { expensiveOpLimiter, signRunArtifacts } from "../middleware/appSetup.js";
import { requireTrigger } from "../middleware/authenticate.js";
import { fireNotifications } from "../utils/notifications.js";
import { validateUrl, safeFetch } from "../utils/ssrfGuard.js";

// ─── SSRF protection for callbackUrl ──────────────────────────────────────────
// Two-layer defence provided by utils/ssrfGuard.js:
//   1. validateUrl() — synchronous string checks + async DNS resolution
//      to block domains that resolve to private/reserved IPs.
//   2. safeFetch() — fires the actual request with `redirect: "error"` to
//      prevent open-redirect bypasses (302 → http://169.254.169.254/…),
//      and re-resolves DNS to mitigate DNS rebinding.

/**
 * Thin wrapper around safeFetch for the callbackUrl POST.
 * Best-effort: errors are silently caught so a failing callback never
 * affects the run outcome.
 *
 * @param {string} url      - The validated callbackUrl.
 * @param {string} payload  - JSON string body.
 */
async function safeFetchCallback(url, payload) {
  await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(10_000),
  });
}

const router = Router();

// Trigger-token authentication is handled by `requireTrigger` from
// middleware/authenticate.js — the centralised strategy-pattern middleware.
// It sets req.triggerToken and req.triggerProject on success, with
// detailed error messages (401/403/404) on failure.

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
 * @param {Object}  req - Express request
 * @param {Object} res - Express response
 */
router.post("/projects/:id/trigger", expensiveOpLimiter, requireTrigger, async (req, res) => {
  const { triggerToken: tokenRow, triggerProject: project } = req;

  // ── 3. Extract and validate optional config (async) ────────────────
  // callbackUrl validation includes DNS resolution, so it must happen
  // BEFORE the synchronous concurrent-run guard to avoid a TOCTOU race
  // (an await between the guard and runRepo.create would let a second
  // request slip through).
  const { dialsConfig, callbackUrl } = req.body || {};

  if (callbackUrl && typeof callbackUrl === "string") {
    // Length cap — prevent abuse via extremely long URLs
    if (callbackUrl.length > 2048) {
      return res.status(400).json({ error: "callbackUrl exceeds maximum length (2048 characters)." });
    }
    const urlErr = await validateUrl(callbackUrl);
    if (urlErr) return res.status(400).json({ error: urlErr });
  }

  const validatedDials = resolveDialsConfig(dialsConfig);
  const parallelWorkers = validatedDials?.parallelWorkers ?? 1;

  // ── 4. Guard: no concurrent run ───────────────────────────────────────
  // From here to runRepo.create() the code is fully synchronous, so no
  // other request can interleave and pass the same guard.
  const existingRun = runRepo.findActiveByProjectId(project.id);
  if (existingRun) {
    return res.status(409).json({
      error: `A run is already in progress (${existingRun.id}).`,
      runId: existingRun.id,
    });
  }

  // ── 5. Guard: approved tests must exist ──────────────────────────────
  const allTests = testRepo.getByProjectId(project.id);
  const tests = allTests.filter((t) => t.reviewStatus === "approved");
  if (!allTests.length) {
    return res.status(400).json({ error: "No tests found — crawl first." });
  }
  if (!tests.length) {
    return res.status(400).json({ error: "No approved tests — review generated tests before triggering." });
  }

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
    workspaceId: project.workspaceId,
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
          workspaceId: project.workspaceId,
          detail: `CI/CD run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
        });
      },
      onFailActivity: (err) => ({
        type: "test_run.fail",
        projectId: project.id,
        projectName: project.name,
        workspaceId: project.workspaceId,
        detail: `CI/CD run failed: ${classifyError(err, "run").message}`,
      }),
      // Fire optional callback URL with run summary on ANY terminal state
      // (completed, failed, aborted) so CI pipelines always get notified.
      // Uses safeFetchCallback which re-resolves DNS (mitigates rebinding)
      // and blocks redirects (mitigates open-redirect SSRF bypass).
      onComplete: async (finishedRun) => {
        // FEA-001: Fire failure notifications — best-effort
        try { await fireNotifications(finishedRun, project); } catch { /* best-effort */ }

        if (!callbackUrl || typeof callbackUrl !== "string") return;
        const payload = JSON.stringify({
          runId,
          status: finishedRun.status,
          passed: finishedRun.passed,
          failed: finishedRun.failed,
          total: finishedRun.total,
          error: finishedRun.error || null,
        });
        safeFetchCallback(callbackUrl, payload)
          .catch(() => { /* best-effort — never fails the run */ });
      },
    },
  );

  // ── 7. Return 202 immediately — client polls statusUrl ───────────────
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  // Point to the token-authenticated status endpoint so CI pipelines can
  // poll without a JWT — they reuse the same Bearer token.
  const statusUrl = `${proto}://${host}/api/v1/projects/${project.id}/trigger/runs/${runId}`;

  res.status(202).json({ runId, statusUrl });
});

/**
 * GET /api/projects/:id/trigger/runs/:runId
 * Token-authenticated run status endpoint for CI/CD pipelines.
 *
 * Uses the same Bearer token auth as POST /trigger so CI pipelines can
 * poll for run completion without a JWT.
 *
 * @param {Object}  req - Express request
 * @param {Object} res - Express response
 */
router.get("/projects/:id/trigger/runs/:runId", requireTrigger, (req, res) => {
  const { triggerProject: project } = req;

  // ── Fetch run ──────────────────────────────────────────────────────
  const run = runRepo.getById(req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  if (run.projectId !== project.id) {
    return res.status(404).json({ error: "run not found" });
  }

  // Return a minimal status payload (no logs or heavy data)
  res.json(signRunArtifacts({
    id: run.id,
    status: run.status,
    passed: run.passed,
    failed: run.failed,
    total: run.total,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    duration: run.duration || null,
    error: run.error || null,
  }));
});

export default router;
