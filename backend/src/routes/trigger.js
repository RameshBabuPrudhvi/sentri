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
import crypto from "node:crypto";
import * as runRepo from "../database/repositories/runRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import * as githubCheckSettingsRepo from "../database/repositories/githubCheckSettingsRepo.js";
import { generateRunId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { runWithAbort } from "../utils/runWithAbort.js";
import { resolveDialsConfig, resolveDialsPrompt } from "../testDials.js";
import { runTests } from "../testRunner.js";
import { crawlAndGenerateTests } from "../crawler.js";
import { classifyError } from "../utils/errorClassifier.js";
import { expensiveOpLimiter, signRunArtifacts } from "../middleware/appSetup.js";
import { requireTrigger } from "../middleware/authenticate.js";
import { fireNotifications } from "../utils/notifications.js";
import { validateUrl, safeFetch } from "../utils/ssrfGuard.js";
import { orderTestsByRisk, applyBudgetToQueue, normalizeBudgetMinutes } from "../pipeline/riskScorer.js";
import { createPending, markInProgress, conclude, buildRunUrl } from "../integrations/githubChecks.js";
import { findGreenBaseRun, renderGithubCheckSummary, conclusionForRun } from "../utils/runResultFormatters.js";
import { formatLogLine } from "../utils/logFormatter.js";

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

// ─── Canonical run-object builders ────────────────────────────────────────────
// Two paths in this file create a `crawl`-type run (POST /trigger with
// `triggerCrawl: true`, and the Vercel/Netlify webhook handlers via
// `launchPreviewCrawl`). Two paths used to construct that same conceptual
// object with different field sets — both worked because `runRepo.create`
// binds missing INSERT_COLS as NULL and `rowToRun` defaults them on read,
// but the drift made it easy to introduce subtle behaviour differences
// (e.g. `tests: []` was missing from one path until a TypeError caught it,
// see PR #12 history). One builder per run type, used by every caller.
//
// Shapes mirror the canonical entries in `routes/runs.js`:
//   - buildCrawlRun → matches runs.js:71-83 (POST /projects/:id/crawl)
//   - buildTestRun  → matches runs.js:161-179 (POST /projects/:id/run)

/**
 * Build a `type: "crawl"` run object aligned with `routes/runs.js:71-83`.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {object} args.project - must carry `id` and (optionally) `workspaceId`.
 * @param {object} [args.dialsConfig] - validated dials (output of
 *   `resolveDialsConfig(...)`). When present, persisted on the run record
 *   as `generateInput: { dialsConfig }` so the RunDetail page can show
 *   which dials drove the crawl and the MNT-010 re-run feature can
 *   replicate the same configuration. Mirrors `runs.js:81`.
 * @returns {object} the run record ready for `runRepo.create()`.
 */
function buildCrawlRun({ runId, project, dialsConfig }) {
  return {
    id: runId,
    projectId: project.id,
    type: "crawl",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    // tests[] is required by persistGeneratedTests (testPersistence.js)
    // which calls `run.tests.push(testId)` during the crawl pipeline.
    tests: [],
    pagesFound: 0,
    // Mirror runs.js:81 so RunDetail + re-run can read back the dials.
    // `undefined` (rather than `null`) so runRepo's INSERT_COLS filter drops
    // the column entirely on no-dials calls — matches the canonical path.
    generateInput: dialsConfig ? { dialsConfig } : undefined,
    workspaceId: project.workspaceId || null,
  };
}

/**
 * Build a `type: "test_run"` run object aligned with `routes/runs.js:188-213`.
 *
 * AUTO-001: persisted `testQueue` mirrors the approved-test order (audit
 * fidelity) with per-row `riskScore`; budget-skipped tests are pre-seeded
 * into `results` as `skipped (over_budget)` so every approved test has an
 * observable resolution. `total` reflects the approved set, not the
 * post-budget dispatch slice.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {object} args.project - must carry `id` and (optionally) `workspaceId`.
 * @param {object[]} args.tests - The full approved-test set (persisted order).
 * @param {object[]} [args.budgetSkipped] - Tests truncated by `budgetMinutes`.
 * @param {Map<string, number>} [args.riskById] - testId → riskScore lookup.
 * @param {number|null} [args.budgetMinutes] - Normalized budget actually applied.
 * @param {number} args.parallelWorkers
 * @returns {object} the run record ready for `runRepo.create()`.
 */
function buildTestRun({ runId, project, tests, budgetSkipped = [], riskById, budgetMinutes = null, parallelWorkers, githubCheck = null }) {
  const lookup = riskById || new Map();
  const initialResults = budgetSkipped.map((t) => ({
    testId: t.id,
    testName: t.name,
    status: "skipped",
    skipReason: "over_budget",
    riskScore: t.riskScore,
  }));
  return {
    id: runId,
    projectId: project.id,
    type: "test_run",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    results: initialResults,
    passed: 0,
    failed: 0,
    total: tests.length,
    parallelWorkers,
    testQueue: tests.map((t) => ({
      id: t.id, name: t.name, steps: t.steps || [],
      riskScore: lookup.get(t.id) ?? null,
    })),
    budgetMinutes,
    workspaceId: project.workspaceId || null,
    githubCheck,
  };
}


function normalizeGithubPayload(body = {}) {
  const repo = typeof body.repo === "string" ? body.repo.trim()
    : body.repository?.full_name ? String(body.repository.full_name).trim() : "";
  // INT-002: extract `head_sha` from any of the four canonical payload shapes:
  //   - `pull_request.head.sha`   → `pull_request.{opened,synchronize,…}` events
  //   - `check_suite.head_sha`    → `check_suite.{requested,rerequested}` events
  //   - `check_run.head_sha`      → `check_run.rerequested` (user clicks "Re-run this check"
  //                                  on a single check, distinct from re-running the whole suite)
  //   - body-level `sha` override → non-GitHub CI callers (Jenkins / GitLab / generic)
  const sha = typeof body.sha === "string" ? body.sha.trim()
    : body.check_run?.head_sha ? String(body.check_run.head_sha).trim()
    : body.check_suite?.head_sha ? String(body.check_suite.head_sha).trim()
    : body.pull_request?.head?.sha ? String(body.pull_request.head.sha).trim() : "";
  // Base SHA is only available on `pull_request` events — `check_run` /
  // `check_suite` payloads don't carry the merge-base, so the regressed-test
  // diff falls back to "all failing" on those events (correct behaviour:
  // a re-run request doesn't change the base, so the original PR delivery
  // already established the green-base reference in `findGreenBaseRun`).
  const baseSha = typeof body.baseSha === "string" ? body.baseSha.trim()
    : body.pull_request?.base?.sha ? String(body.pull_request.base.sha).trim() : null;
  // `check_run.pull_requests[0].number` carries the PR number on check-run
  // rerequest events when the check belongs to a PR (vs. a branch push).
  const prNumber = Number.isInteger(body.prNumber) ? body.prNumber
    : Number.isInteger(body.number) ? body.number
    : Number.isInteger(body.pull_request?.number) ? body.pull_request.number
    : Number.isInteger(body.check_run?.pull_requests?.[0]?.number) ? body.check_run.pull_requests[0].number : null;
  return { repo, sha, baseSha, prNumber };
}

/**
 * Prepare a GitHub Check Run for a Sentri run, returning the metadata to
 * persist on `run.githubCheck` (or `null` when no check should be created).
 *
 * **Idempotency contract (INT-002):**
 * GitHub retries failed webhook deliveries (any non-2xx) with exponential
 * backoff for up to 24h, always using the same `X-GitHub-Delivery` UUID.
 * The delivery ID — not the commit SHA — is the correct idempotency key:
 *   - Same delivery ID → GitHub is retrying. Return existing check, do not
 *     create a new run, do not transition state on GitHub.
 *   - New delivery ID for the same SHA → distinct event (e.g. `rerequested`
 *     after a user clicks "Re-run"). Create a fresh Check Run.
 *
 * @param {Object} project
 * @param {Object} body          — trigger request body (already merged with normalizeGithubPayload).
 * @param {string} runId
 * @param {string|null} deliveryId — value of the `X-GitHub-Delivery` header, when present.
 * @returns {Promise<Object|null>}
 */
async function prepareGithubCheck(project, body, runId, deliveryId = null) {
  const payload = normalizeGithubPayload(body);
  if (!payload.repo || !payload.sha) return null;
  const settings = githubCheckSettingsRepo.getByProjectId(project.id);
  if (!settings?.enabled) return null;
  if (settings.repo && settings.repo !== payload.repo) return null;
  if (!settings.installationId) throw new Error("GitHub installationId is not configured for this project");

  // Retry-delivery idempotency: same X-GitHub-Delivery ⇒ same check, no
  // state transition. The caller (handleTrigger) short-circuits when it
  // detects `reused: true` so the underlying Sentri run is also skipped.
  if (deliveryId) {
    const existing = runRepo.findByGithubDeliveryId(project.id, deliveryId);
    if (existing?.githubCheck?.checkRunId) {
      return { ...existing.githubCheck, reused: true, reusedRunId: existing.id };
    }
  }

  const checkRun = await createPending(runId, {
    repo: payload.repo,
    sha: payload.sha,
    installationId: settings.installationId,
  });
  await markInProgress(checkRun.id, { repo: payload.repo, installationId: settings.installationId });
  return {
    checkRunId: checkRun.id,
    deliveryId: deliveryId || null,
    repo: payload.repo,
    sha: payload.sha,
    baseSha: payload.baseSha,
    prNumber: payload.prNumber,
    installationId: settings.installationId,
    status: "in_progress",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Conclude a GitHub Check Run once the Sentri run reaches a terminal state.
 *
 * **Placement rationale (deviates from NEXT.md INT-002 sketch):**
 * NEXT.md suggests this hook lives in `testRunner.js` `onComplete`. We keep
 * it here because (a) `testRunner.js` has no internal completion hook —
 * `runWithAbort.onComplete` *is* the hook, fired from this file already;
 * (b) only the trigger path carries GitHub repo/sha context, so wiring it
 * through the runner would require threading `run.githubCheck` plumbing
 * into a module that has no other reason to know about integrations;
 * (c) keeping integration side-effects at the route layer matches the
 * pattern used by `fireNotifications` (FEA-001) just above this call.
 * Errors are always logged + swallowed so a GitHub outage never fails the
 * underlying Sentri run (INT-002 anti-pattern guard).
 *
 * @param {Object} finishedRun
 * @param {Object} project
 */
async function concludeGithubCheck(finishedRun, project) {
  const check = finishedRun?.githubCheck;
  if (!check?.checkRunId || !check.repo || !check.installationId) return;
  try {
    // INT-002 perf: use the lean accessor instead of `getByProjectId()` —
    // the latter loads every historical run with full JSON deserialization
    // (testQueue, promptAudit, qualityAnalytics, …) which becomes a real
    // latency cost on projects with hundreds of runs. The base-run lookup
    // only needs id/type/status/failed/githubCheck/results, bounded to the
    // 25-run lookback `findGreenBaseRun` already enforces.
    const projectRuns = runRepo.getRecentTestRunsForGithubBase(project.id);
    const baseRun = findGreenBaseRun(projectRuns, check.baseSha, check.repo);
    const summaryMd = renderGithubCheckSummary(finishedRun, { baseRun, runUrl: buildRunUrl(finishedRun.id) || "" });
    await conclude(check.checkRunId, {
      repo: check.repo,
      installationId: check.installationId,
      conclusion: conclusionForRun(finishedRun),
      summaryMd,
    });
    runRepo.update(finishedRun.id, { githubCheck: { ...check, status: "completed", conclusion: conclusionForRun(finishedRun), completedAt: new Date().toISOString() } });
  } catch (err) {
    // INT-002 anti-pattern guard: a GitHub 5xx must never fail the underlying
    // Sentri run — log and swallow.
    console.error(formatLogLine("warn", finishedRun.id, `[github-checks] Failed to conclude check: ${err.message}`));
  }
}

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
async function handleTrigger(req, res) {
  const { triggerToken: tokenRow, triggerProject: project } = req;

  // ── 3. Extract and validate optional config (async) ────────────────
  // callbackUrl validation includes DNS resolution, so it must happen
  // BEFORE the synchronous concurrent-run guard to avoid a TOCTOU race
  // (an await between the guard and runRepo.create would let a second
  // request slip through).
  const { dialsConfig, callbackUrl, budgetMinutes } = req.body || {};

  if (callbackUrl && typeof callbackUrl === "string") {
    // Length cap — prevent abuse via extremely long URLs
    if (callbackUrl.length > 2048) {
      return res.status(400).json({ error: "callbackUrl exceeds maximum length (2048 characters)." });
    }
    const urlErr = await validateUrl(callbackUrl);
    if (urlErr) return res.status(400).json({ error: urlErr });
  }

  // SSRF protection for previewUrl — same DNS-resolving validation used for
  // callbackUrl. Without this, a valid trigger token could redirect the
  // browser crawl at an internal address (e.g. cloud metadata, RFC1918).
  if (req.body?.previewUrl && typeof req.body.previewUrl === "string") {
    if (req.body.previewUrl.length > 2048) {
      return res.status(400).json({ error: "previewUrl exceeds maximum length (2048 characters)." });
    }
    const previewErr = await validateUrl(req.body.previewUrl);
    if (previewErr) return res.status(400).json({ error: previewErr });
  }

  const validatedDials = resolveDialsConfig(dialsConfig);
  const parallelWorkers = validatedDials?.parallelWorkers ?? 1;
  // AUTO-002 / AUTO-015: honour dialsConfig on the crawl path too — `runs.js`
  // already derives these from the same `validatedDials` and forwards them to
  // crawlAndGenerateTests at runs.js:108. Without this the trigger path
  // silently runs every crawl with defaults regardless of caller config.
  const dialsPrompt = resolveDialsPrompt(dialsConfig);
  const testCount = validatedDials?.testCount || "ai_decides";
  const explorerMode = validatedDials?.exploreMode || "crawl";
  const explorerTuning = {
    maxStates:     validatedDials?.exploreMaxStates     ?? 30,
    maxDepth:      validatedDials?.exploreMaxDepth      ?? 3,
    maxActions:    validatedDials?.exploreMaxActions    ?? 8,
    actionTimeout: validatedDials?.exploreActionTimeout ?? 5000,
  };

  // ── 3b. GitHub delivery-retry idempotency (INT-002) ───────────────────
  // GitHub retries non-2xx webhook deliveries with the same X-GitHub-Delivery
  // UUID for up to 24h. If we've already started a run for this exact
  // delivery, ack with the existing runId + checkRunId and DO NOT create a
  // second Sentri run. This is the only correct "duplicate" — same SHA from
  // a distinct delivery (e.g. `check_suite.rerequested`) is a fresh event.
  const githubDeliveryId = req.githubDeliveryId || null;
  if (githubDeliveryId) {
    const dup = runRepo.findByGithubDeliveryId(project.id, githubDeliveryId);
    if (dup?.githubCheck?.checkRunId) {
      const proto = req.headers["x-forwarded-proto"] || req.protocol;
      const host  = req.headers["x-forwarded-host"]  || req.get("host");
      return res.status(202).json({
        runId: dup.id,
        statusUrl: `${proto}://${host}/api/v1/projects/${project.id}/trigger/runs/${dup.id}`,
        githubCheck: { checkRunId: dup.githubCheck.checkRunId, reused: true },
      });
    }
  }

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

  const triggerCrawl = req.body?.triggerCrawl === true;
  const previewUrl = typeof req.body?.previewUrl === "string" ? req.body.previewUrl : null;
  const allTests = testRepo.getByProjectId(project.id);
  const tests = allTests.filter((t) => t.reviewStatus === "approved");
  // AUTO-001: risk-ordered + budget-capped dispatch set. `tests` (approved order)
  // is preserved for the audit-trail `testIds` snapshot below; reorder is for
  // DISPATCH only.
  //
  // History is bounded to the 20 most recent completed test runs via the lean
  // accessor `getRecentCompletedWithResults` (id/type/status/startedAt/results
  // only — no testQueue/promptAudit/qualityAnalytics blobs). The scorer caps
  // its per-test window at the 10 newest results anyway (`riskScorer.js`
  // `rows.slice(0, 10)` — newest-first), so 20 runs gives ample headroom
  // while keeping memory bounded on projects with hundreds of historical runs.
  const RISK_HISTORY_RUN_LIMIT = 20;
  const recentRuns = runRepo.getRecentCompletedWithResults(project.id, RISK_HISTORY_RUN_LIMIT);
  const history = recentRuns.flatMap((r) => Array.isArray(r.results) ? r.results : []);
  // Lean lookup — single-row SQL with `LIMIT 1`, no full-table scan.
  const latestCrawl = runRepo.getLatestCrawlWithChangedPages(project.id);
  const changedPages = (latestCrawl?.changedPages || []).map((p) => p?.url || p).filter(Boolean);
  const safeBudget = normalizeBudgetMinutes(budgetMinutes);
  const riskOrderedTests = orderTestsByRisk(tests, history, { changedPages });
  const { kept: selectedTests, skipped: budgetSkipped } = applyBudgetToQueue(riskOrderedTests, safeBudget);
  const riskById = new Map(riskOrderedTests.map((t) => [t.id, t.riskScore]));
  if (!triggerCrawl) {
    if (!allTests.length) return res.status(400).json({ error: "No tests found — crawl first." });
    if (!tests.length) return res.status(400).json({ error: "No approved tests — review generated tests before triggering." });
  }

  // ── 6. Create and start the run ──────────────────────────────────────
  // One canonical builder per run type. Both shapes match the equivalents
  // in `routes/runs.js` so test_run / crawl runs created via this endpoint
  // are byte-identical to the ones POST /run and POST /crawl produce.
  const runId = generateRunId();
  const run = triggerCrawl
    ? buildCrawlRun({ runId, project, dialsConfig: validatedDials })
    : buildTestRun({ runId, project, tests, budgetSkipped, riskById, budgetMinutes: safeBudget, parallelWorkers });
  runRepo.create(run);

  if (!triggerCrawl) {
    // INT-002: GitHub Check Run setup is best-effort. A GitHub outage / 5xx
    // / misconfiguration must never block the underlying Sentri run — the
    // run itself is the source of truth; the PR check is a notification
    // surface. Failures here are logged and swallowed, mirroring the
    // `concludeGithubCheck` contract on the completion side.
    try {
      run.githubCheck = await prepareGithubCheck(project, req.body || {}, runId, githubDeliveryId);
      if (run.githubCheck) runRepo.update(runId, { githubCheck: run.githubCheck });
    } catch (err) {
      console.error(formatLogLine("warn", runId, `[github-checks] Failed to create pending check: ${err.message}`));
    }
  }

  // Record that this token was used (updates lastUsedAt)
  webhookTokenRepo.touch(tokenRow.id);

  // AUTO-002 / AUTO-015: when `triggerCrawl` is true we dispatch through
  // `crawlAndGenerateTests`, so the activity rows must use the `crawl.*`
  // type family (matching `runs.js:85-88`). Otherwise dashboard analytics
  // that group by activity type miscount crawls as test runs and the
  // detail text ("0 tests") is misleading on a fresh-project crawl.
  logActivity({
    type: triggerCrawl ? "crawl.start" : "test_run.start",
    projectId: project.id,
    projectName: project.name,
    workspaceId: project.workspaceId,
    detail: triggerCrawl
      ? `CI/CD triggered crawl${previewUrl ? ` — ${previewUrl}` : ""}`
      : `CI/CD triggered test run — ${selectedTests.length} of ${tests.length} test${tests.length !== 1 ? "s" : ""}${budgetSkipped.length ? ` (${budgetSkipped.length} skipped over budget)` : ""}${parallelWorkers > 1 ? ` (${parallelWorkers}x parallel)` : ""}`,
    status: "running",
  });

  // AUTO-015b: if this is a deployment-preview crawl (`triggerCrawl: true` +
  // `previewUrl`), also emit the `crawl.start.deployment` marker so the
  // "Last deployment run" badge on the project header surfaces CI-pipeline-
  // triggered preview crawls — not just provider-webhook ones. The badge
  // query (`GET /projects/:id/last-deployment-run`) filters on this exact
  // type and reads `meta.runId` to cross-reference the run record.
  if (triggerCrawl && previewUrl) {
    logActivity({
      type: "crawl.start.deployment",
      projectId: project.id,
      projectName: project.name,
      workspaceId: project.workspaceId,
      detail: `CI/CD deployment — ${previewUrl}`,
      status: "running",
      meta: { provider: "ci", previewUrl, runId },
    });
  }

  runWithAbort(runId, run,
    (signal) => triggerCrawl
      // AUTO-002 / AUTO-015: when crawling a preview URL we overwrite
      // `project.url` with `previewUrl`, but we MUST preserve the original
      // production URL as `canonicalUrl` so the diff-aware baseline guard
      // in crawler.js can detect this is a preview crawl and skip
      // replacing the production baselines. Without this, the sameOrigin
      // check sees preview === preview (both sides equal because project.url
      // was already overridden) and silently destroys the real fingerprints.
      ? crawlAndGenerateTests(
          { ...project, url: previewUrl || project.url, canonicalUrl: project.url },
          run,
          { dialsPrompt, testCount, explorerMode, explorerTuning, signal }
        )
      // AUTO-001: dispatch the risk-ordered + budget-capped subset, not the
      // full approved set. The persisted run (buildTestRun) still records the
      // approved-test order via `tests` for audit fidelity.
      : runTests(project, selectedTests, run, { parallelWorkers, signal }),
    {
      onSuccess: () => {
        logActivity({
          type: triggerCrawl ? "crawl.complete" : "test_run.complete",
          projectId: project.id,
          projectName: project.name,
          workspaceId: project.workspaceId,
          detail: triggerCrawl
            ? `CI/CD crawl completed — ${run.pagesFound || 0} page(s), ${run.tests?.length || 0} test(s) generated`
            : `CI/CD run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
        });
      },
      onFailActivity: (err) => ({
        type: triggerCrawl ? "crawl.fail" : "test_run.fail",
        projectId: project.id,
        projectName: project.name,
        workspaceId: project.workspaceId,
        detail: triggerCrawl
          ? `CI/CD crawl failed: ${classifyError(err, "crawl").message}`
          : `CI/CD run failed: ${classifyError(err, "run").message}`,
      }),
      // Fire optional callback URL with run summary on ANY terminal state
      // (completed, failed, aborted) so CI pipelines always get notified.
      // Uses safeFetchCallback which re-resolves DNS (mitigates rebinding)
      // and blocks redirects (mitigates open-redirect SSRF bypass).
      onComplete: async (finishedRun) => {
        // FEA-001: Fire failure notifications — best-effort
        try { await fireNotifications(finishedRun, project); } catch { /* best-effort */ }
        await concludeGithubCheck(finishedRun, project);

        if (!callbackUrl || typeof callbackUrl !== "string") return;
        const payload = JSON.stringify({
          runId,
          status: finishedRun.status,
          passed: finishedRun.passed,
          failed: finishedRun.failed,
          total: finishedRun.total,
          error: finishedRun.error || null,
          gateResult: finishedRun.gateResult || null,
          webVitalsResult: finishedRun.webVitalsResult || null,
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

  const response = { runId, statusUrl };
  if (run.githubCheck?.checkRunId) {
    response.githubCheck = { checkRunId: run.githubCheck.checkRunId, reused: false };
  }
  res.status(202).json(response);
}

router.post("/projects/:id/trigger", expensiveOpLimiter, requireTrigger, handleTrigger);

/**
 * HMAC signature verification for deployment-webhook payloads.
 *
 * **Per-provider algorithm choice is dictated by each provider, not by us:**
 * - Vercel: HMAC-**SHA1** over the raw body (`X-Vercel-Signature` header).
 *   Vercel's current webhook spec still signs with SHA-1; any change would
 *   have to come from Vercel. HMAC-SHA1 (unlike plain SHA-1) is not known
 *   to be vulnerable — the keyed prefix construction defeats the collision
 *   attacks that retired SHA-1 for certificate signing. Pre-image resistance
 *   in HMAC depends on the key, not the hash, so an attacker who cannot
 *   guess `VERCEL_WEBHOOK_SECRET` cannot forge a valid signature.
 * - Netlify: HMAC-**SHA256** over the raw body (`X-Netlify-Token` header).
 *
 * If you're auditing this and wondering "why SHA-1?" — the answer is
 * interoperability with the provider's signing scheme. When Vercel upgrades
 * their webhook signatures, bump `algo` for the `"vercel"` branch here.
 *
 * @param {"vercel"|"netlify"|"github"} provider
 * @param {Buffer|undefined} rawBody - captured by the webhook-scoped
 *   express.json `verify` callback in `middleware/appSetup.js`.
 * @param {string|undefined} signatureHeader - the provider's signature header
 *   value; tolerates both raw hex and `"<algo>=<hex>"` prefix forms.
 * @returns {boolean}
 */
export function verifyWebhookSignature(provider, rawBody, signatureHeader) {
  const secret = provider === "vercel"
    ? process.env.VERCEL_WEBHOOK_SECRET
    : provider === "github"
    ? process.env.GITHUB_WEBHOOK_SECRET
    : process.env.NETLIFY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader || !rawBody) return false;
  const algo = provider === "vercel" ? "sha1" : "sha256";
  const expected = crypto.createHmac(algo, secret).update(rawBody).digest("hex");
  const provided = signatureHeader.startsWith(`${algo}=`) ? signatureHeader.slice(algo.length + 1) : signatureHeader;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Launch a crawl run against a deployment-preview URL. Shared by the Vercel
 * and Netlify webhook handlers below — kept in one place so the run-object
 * shape and runWithAbort wiring stay aligned with `runs.js:71-127`
 * (the canonical crawl entry point).
 *
 * The caller must have already (a) verified the provider's HMAC signature,
 * (b) authenticated the trigger token via requireTrigger, and (c) validated
 * `previewUrl` via SSRF guard.
 *
 * AUTO-015b: emits a dedicated `crawl.start.deployment` activity row (see
 * below) alongside the standard `crawl.start`, so the "Last deployment run"
 * badge on the project header can distinguish webhook-launched crawls from
 * manually-triggered ones via the activity log without a schema change.
 */
async function launchPreviewCrawl({ project, previewUrl, provider, tokenRow, dialsConfig }) {
  // AUTO-002 / AUTO-015: derive crawl options from optional dialsConfig in the
  // webhook payload. Provider webhook bodies don't carry these today, but
  // future Vercel/Netlify integrations (or Sentri-side admin overrides) can
  // pass them through — keeping the signature uniform with POST /trigger
  // means there's no second config-routing path to maintain.
  const validatedDials = resolveDialsConfig(dialsConfig);
  const dialsPrompt = resolveDialsPrompt(dialsConfig);
  const testCount = validatedDials?.testCount || "ai_decides";
  const explorerMode = validatedDials?.exploreMode || "crawl";
  const explorerTuning = {
    maxStates:     validatedDials?.exploreMaxStates     ?? 30,
    maxDepth:      validatedDials?.exploreMaxDepth      ?? 3,
    maxActions:    validatedDials?.exploreMaxActions    ?? 8,
    actionTimeout: validatedDials?.exploreActionTimeout ?? 5000,
  };

  // Concurrent-run guard — same as POST /trigger
  const existingRun = runRepo.findActiveByProjectId(project.id);
  if (existingRun) {
    return { status: 409, body: { error: `A run is already in progress (${existingRun.id}).`, runId: existingRun.id } };
  }

  const runId = generateRunId();
  // Same canonical shape as POST /trigger's crawl branch and runs.js's
  // POST /crawl — see buildCrawlRun JSDoc above. `validatedDials` is
  // forwarded so the run record carries `generateInput: { dialsConfig }`
  // exactly like manually-triggered crawls.
  const run = buildCrawlRun({ runId, project, dialsConfig: validatedDials });
  runRepo.create(run);

  if (tokenRow) webhookTokenRepo.touch(tokenRow.id);

  // AUTO-015 / AUTO-015b: log the standard `crawl.start` so dashboard
  // counters treat this like any other crawl, PLUS a dedicated
  // `crawl.start.deployment` marker so the "Last deployment run" badge
  // on the project header (NEXT.md:69) can distinguish webhook-launched
  // runs from manually-triggered ones without a schema change. The
  // `meta` payload carries the provider + preview URL + runId for the
  // badge query in `GET /projects/:id/last-deployment-run`.
  logActivity({
    type: "crawl.start",
    projectId: project.id,
    projectName: project.name,
    workspaceId: project.workspaceId,
    detail: `${provider} deployment webhook — crawl ${previewUrl}`,
    status: "running",
  });
  logActivity({
    type: "crawl.start.deployment",
    projectId: project.id,
    projectName: project.name,
    workspaceId: project.workspaceId,
    detail: `${provider} deployment — ${previewUrl}`,
    status: "running",
    meta: { provider, previewUrl, runId },
  });

  runWithAbort(runId, run,
    // AUTO-015: preserve `canonicalUrl` alongside the preview-URL override —
    // crawler.js's sameOrigin guard needs the original project URL to
    // detect that this is a preview crawl and skip baseline replacement.
    // Without this, production baselines would be overwritten with
    // preview-URL fingerprints every time a deployment webhook fires.
    (signal) => crawlAndGenerateTests(
      { ...project, url: previewUrl, canonicalUrl: project.url },
      run,
      { dialsPrompt, testCount, explorerMode, explorerTuning, signal }
    ),
    {
      onSuccess: () => logActivity({
        type: "crawl.complete",
        projectId: project.id,
        projectName: project.name,
        workspaceId: project.workspaceId,
        detail: `${provider} preview crawl completed — ${run.pagesFound || 0} pages, ${run.tests?.length || 0} test(s) generated`,
      }),
      onFailActivity: (err) => ({
        type: "crawl.fail",
        projectId: project.id,
        projectName: project.name,
        workspaceId: project.workspaceId,
        detail: `${provider} preview crawl failed: ${classifyError(err, "crawl").message}`,
      }),
      onComplete: async (finishedRun) => {
        try { await fireNotifications(finishedRun, project); } catch { /* best-effort */ }
      },
    },
  );

  return { status: 202, body: { ok: true, provider, runId, previewUrl } };
}

/**
 * Webhook handlers require BOTH:
 *   1. A valid HMAC signature from the deployment provider (proves Vercel/
 *      Netlify sent the payload — protects against forged calls).
 *   2. A project-scoped trigger token via `requireTrigger` (proves which
 *      project should run — without this, a single global webhook secret
 *      would let any signed payload trigger any project ID in the URL).
 */

// INT-002: GitHub fires webhooks for many event types — `ping` when the
// hook is first installed, plus `push`, `issues`, `issue_comment`,
// `workflow_run`, `star`, etc. depending on subscriptions. Without an
// event-type filter, ANY delivery (including the install-time ping)
// would launch a Sentri run. Mirror the Vercel/Netlify gate: only
// PR-lifecycle events relevant to QA proceed; everything else is acked
// 200 so GitHub stops retrying.
const TRIGGERING_GITHUB_EVENTS = new Map([
  ["pull_request", new Set(["opened", "synchronize", "reopened", "ready_for_review"])],
  ["check_suite", new Set(["requested", "rerequested"])],
  // `check_run.rerequested` fires when a user clicks "Re-run this check" on a
  // single check (distinct from `check_suite.rerequested` which re-runs every
  // check in the suite). Industry-standard QA gates honour both — without this
  // entry, the per-check "Re-run" button silently no-ops, which is surprising
  // UX for anyone used to GitHub Actions / CircleCI behaviour.
  ["check_run", new Set(["rerequested"])],
]);

router.post("/projects/:id/trigger/github", expensiveOpLimiter, requireTrigger, async (req, res) => {
  const sig = req.get("X-Hub-Signature-256");
  if (!verifyWebhookSignature("github", req.rawBody, sig)) return res.status(401).json({ error: "invalid signature" });

  const event = req.get("X-GitHub-Event") || "";
  const action = typeof req.body?.action === "string" ? req.body.action : "";
  const allowedActions = TRIGGERING_GITHUB_EVENTS.get(event);
  // `check_suite.requested` carries no `action`-bearing PR context on some
  // forks, but the canonical webhook always supplies one. Reject events
  // without a matching action — including `ping`, which has no action and
  // no `pull_request` / `check_suite` payload.
  if (!allowedActions || !allowedActions.has(action)) {
    return res.status(200).json({ ok: true, ignored: true, reason: "event not triggering", event, action });
  }

  const payload = normalizeGithubPayload(req.body || {});
  // Only short-circuit when settings exist AND are explicitly disabled, or
  // when the configured repo doesn't match the incoming payload. Projects
  // that have never configured `github_check_settings` should still be able
  // to trigger via this webhook — the GitHub Check Run side of things is
  // already gated separately inside `prepareGithubCheck` (no settings ⇒
  // no check-run created, but the Sentri test run still executes). Treating
  // "no settings row" as "disabled" here would silently break every project
  // that hasn't opted into PR checks yet — see review on PR #17.
  const settings = githubCheckSettingsRepo.getByProjectId(req.triggerProject?.id || req.params.id);
  if (settings && settings.enabled === false) {
    return res.status(200).json({ ok: true, ignored: true, reason: "github checks disabled" });
  }
  if (settings?.repo && payload.repo && settings.repo !== payload.repo) {
    return res.status(200).json({ ok: true, ignored: true, reason: "repo mismatch" });
  }

  // Capture the GitHub delivery UUID so handleTrigger can dedupe retries.
  // GitHub guarantees this header on every webhook delivery and reuses the
  // same UUID across all retry attempts of a given delivery.
  req.githubDeliveryId = req.get("X-GitHub-Delivery") || null;
  req.body = { ...(req.body || {}), ...payload };
  return handleTrigger(req, res);
});

router.post("/projects/:id/trigger/vercel", expensiveOpLimiter, requireTrigger, async (req, res) => {
  const sig = req.get("X-Vercel-Signature");
  if (!verifyWebhookSignature("vercel", req.rawBody, sig)) return res.status(401).json({ error: "invalid signature" });

  // AUTO-015: Vercel emits webhook events for every deployment state
  // (CREATED, BUILDING, READY, ERROR, CANCELED, …). Crawling a deployment
  // that isn't yet serving content captures a "building" placeholder page
  // (junk tests) or fails with a navigation error. Only fire on READY —
  // accept either the v1 event-type form (`type: "deployment.ready"` /
  // `"deployment.succeeded"`) or the v2 readyState form
  // (`deployment.readyState: "READY"`). Anything else acks 200 (so Vercel
  // doesn't retry indefinitely) without launching a run.
  const eventType = typeof req.body?.type === "string" ? req.body.type : "";
  const readyState = typeof req.body?.deployment?.readyState === "string" ? req.body.deployment.readyState : "";
  const isReady =
    eventType === "deployment.ready" ||
    eventType === "deployment.succeeded" ||
    readyState.toUpperCase() === "READY";
  if (!isReady) {
    return res.status(200).json({ ok: true, ignored: true, reason: "deployment not ready", eventType, readyState });
  }

  const deploymentUrl = req.body?.deployment?.url;
  if (!deploymentUrl) return res.status(400).json({ error: "deployment.url missing from payload" });
  const previewUrl = `https://${String(deploymentUrl).replace(/^https?:\/\//, "")}`;

  // SSRF guard — same DNS-resolving validation used elsewhere in this file
  if (previewUrl.length > 2048) return res.status(400).json({ error: "previewUrl exceeds maximum length (2048 characters)." });
  const previewErr = await validateUrl(previewUrl);
  if (previewErr) return res.status(400).json({ error: previewErr });

  const { triggerProject: project, triggerToken: tokenRow } = req;
  const { status, body } = await launchPreviewCrawl({ project, previewUrl, provider: "vercel", tokenRow });
  res.status(status).json(body);
});

router.post("/projects/:id/trigger/netlify", expensiveOpLimiter, requireTrigger, async (req, res) => {
  const sig = req.get("X-Netlify-Token");
  if (!verifyWebhookSignature("netlify", req.rawBody, sig)) return res.status(401).json({ error: "invalid signature" });

  // AUTO-015: Netlify deploy notifications fire for every deploy state
  // (`new`, `building`, `ready`, `error`, `processing`, …). Crawling a
  // deploy that isn't yet serving content captures a "building" placeholder
  // page (junk tests) or fails with a navigation error — and Netlify allocates
  // `deploy_ssl_url` / `deploy_url` early in the lifecycle, so the URL alone
  // isn't a readiness signal. Only fire on `state === "ready"`. Anything else
  // acks 200 (so Netlify doesn't retry indefinitely) without launching a run.
  const state = typeof req.body?.state === "string" ? req.body.state : "";
  if (state.toLowerCase() !== "ready") {
    return res.status(200).json({ ok: true, ignored: true, reason: "deploy not ready", state });
  }

  const previewUrl = req.body?.deploy_ssl_url || req.body?.deploy_url || null;
  if (!previewUrl) return res.status(400).json({ error: "deploy_ssl_url / deploy_url missing from payload" });

  if (previewUrl.length > 2048) return res.status(400).json({ error: "previewUrl exceeds maximum length (2048 characters)." });
  const previewErr = await validateUrl(previewUrl);
  if (previewErr) return res.status(400).json({ error: previewErr });

  const { triggerProject: project, triggerToken: tokenRow } = req;
  const { status, body } = await launchPreviewCrawl({ project, previewUrl, provider: "netlify", tokenRow });
  res.status(status).json(body);
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
    gateResult: run.gateResult || null,
    webVitalsResult: run.webVitalsResult || null,
  }));
});

export default router;
