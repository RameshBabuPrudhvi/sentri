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
import { orderTestsByRisk, applyBudgetToQueue } from "../pipeline/riskScorer.js";

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
 * Build a `type: "test_run"` run object aligned with `routes/runs.js:161-179`.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {object} args.project - must carry `id` and (optionally) `workspaceId`.
 * @param {object[]} args.tests - The approved tests this run will execute.
 *   Each entry must carry `id`, `name`, and optionally `steps` (defaults to []).
 * @param {number} args.parallelWorkers
 * @returns {object} the run record ready for `runRepo.create()`.
 */
function buildTestRun({ runId, project, tests, parallelWorkers }) {
  return {
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
    workspaceId: project.workspaceId || null,
  };
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
router.post("/projects/:id/trigger", expensiveOpLimiter, requireTrigger, async (req, res) => {
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
  const history = runRepo.getByProjectId(project.id).flatMap((r) => Array.isArray(r.results) ? r.results : []);
  const riskOrderedTests = orderTestsByRisk(tests, history, { changedPages: [] });
  const selectedTests = applyBudgetToQueue(riskOrderedTests, budgetMinutes);
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
    : buildTestRun({ runId, project, tests, parallelWorkers });
  runRepo.create(run);

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
      : `CI/CD triggered test run — ${tests.length} test${tests.length !== 1 ? "s" : ""}${parallelWorkers > 1 ? ` (${parallelWorkers}x parallel)` : ""}`,
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
      : runTests(project, tests, run, { parallelWorkers, signal }),
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

  res.status(202).json({ runId, statusUrl });
});

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
 * @param {"vercel"|"netlify"} provider
 * @param {Buffer|undefined} rawBody - captured by the webhook-scoped
 *   express.json `verify` callback in `middleware/appSetup.js`.
 * @param {string|undefined} signatureHeader - the provider's signature header
 *   value; tolerates both raw hex and `"<algo>=<hex>"` prefix forms.
 * @returns {boolean}
 */
function verifyWebhookSignature(provider, rawBody, signatureHeader) {
  const secret = provider === "vercel" ? process.env.VERCEL_WEBHOOK_SECRET : process.env.NETLIFY_WEBHOOK_SECRET;
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
