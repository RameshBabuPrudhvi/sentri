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
import { URL } from "url";
import dns from "node:dns";
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
import { expensiveOpLimiter, signRunArtifacts } from "../middleware/appSetup.js";

// ─── SSRF protection for callbackUrl ──────────────────────────────────────────
// Two-layer defence:
//   1. validateCallbackUrl() — synchronous string checks + async DNS resolution
//      to block domains that resolve to private/reserved IPs.
//   2. safeFetchCallback() — fires the actual POST with `redirect: "error"` to
//      prevent open-redirect bypasses (302 → http://169.254.169.254/…).

/** @type {Array<Array<number>>} [baseIp, mask, bits] for IPv4 */
const PRIVATE_IPV4_RANGES = [
  // 10.0.0.0/8
  [0x0A000000, 0xFF000000, 8],
  // 172.16.0.0/12
  [0xAC100000, 0xFFF00000, 12],
  // 192.168.0.0/16
  [0xC0A80000, 0xFFFF0000, 16],
  // 127.0.0.0/8 (loopback)
  [0x7F000000, 0xFF000000, 8],
  // 169.254.0.0/16 (link-local / cloud metadata)
  [0xA9FE0000, 0xFFFF0000, 16],
  // 0.0.0.0/8
  [0x00000000, 0xFF000000, 8],
];

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(ip) {
  // IPv6 loopback
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;

  // Only check IPv6 prefix ranges when the input is actually an IPv6 address
  // (contains a colon).  Without this guard, hostnames like "fdic.gov",
  // "fcbarcelona.com", or "ffmpeg.org" would be falsely rejected because
  // their first characters match IPv6 private-range prefixes.
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    // fc00::/7 — unique local addresses (includes fd00::/8)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // fe80::/10 — link-local
    if (lower.startsWith("fe80")) return true;
    // ff00::/8 — multicast
    if (lower.startsWith("ff")) return true;
    // :: — unspecified address
    if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return true;
  }

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  const v4match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const v4 = v4match ? v4match[1] : ip;
  const num = ipv4ToInt(v4);
  if (num === null) return false; // not an IP address — hostname validation is handled by the caller
  for (const [base, mask] of PRIVATE_IPV4_RANGES) {
    if (((num & mask) >>> 0) === base) return true;
  }
  return false;
}

/**
 * Validate a callbackUrl for SSRF safety.
 *
 * Performs synchronous string checks (protocol, known private hostnames,
 * literal private IPs) and then resolves the hostname via DNS to catch
 * domains that point to private/reserved addresses (e.g. evil.com → 169.254.169.254).
 *
 * @param {string} raw
 * @returns {Promise<string|null>} null if valid, or an error message string.
 */
async function validateCallbackUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return "callbackUrl is not a valid URL."; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "callbackUrl must use http or https.";
  }
  // Block obvious private hostnames
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return "callbackUrl must not target a private/internal host.";
  }
  if (isPrivateIp(host)) {
    return "callbackUrl must not target a private or reserved IP address.";
  }

  // Resolve DNS to catch domains pointing to private IPs (e.g. evil.com → 10.0.0.1).
  // Skip resolution for bare IP addresses — already checked above.
  // Use dns.resolve4/resolve6 to check ALL addresses (not just the first one
  // returned by lookup) — a domain with a safe A record but a private AAAA
  // record would bypass a single-address check.
  if (ipv4ToInt(host) === null && !host.includes(":")) {
    try {
      const [v4addrs, v6addrs] = await Promise.all([
        dns.promises.resolve4(host).catch(() => []),
        dns.promises.resolve6(host).catch(() => []),
      ]);
      const allAddrs = [...v4addrs, ...v6addrs];
      if (allAddrs.length === 0) {
        return "callbackUrl hostname could not be resolved.";
      }
      for (const addr of allAddrs) {
        if (isPrivateIp(addr)) {
          return "callbackUrl resolves to a private or reserved IP address.";
        }
      }
    } catch {
      return "callbackUrl hostname could not be resolved.";
    }
  }

  return null; // valid
}

/**
 * Fire the callbackUrl POST with SSRF-safe fetch options.
 *
 * - `redirect: "error"` prevents the server from following 302 redirects to
 *   private IPs (open-redirect bypass).
 * - Re-resolves DNS at fetch time to mitigate DNS rebinding (where the domain
 *   changes resolution between validateCallbackUrl and the actual fetch).
 * - Best-effort: errors are silently caught so a failing callback never
 *   affects the run outcome.
 *
 * @param {string} url      - The validated callbackUrl.
 * @param {string} payload  - JSON string body.
 */
async function safeFetchCallback(url, payload) {
  // Re-resolve DNS at fetch time to mitigate DNS rebinding attacks.
  // Check all resolved addresses (both A and AAAA) to prevent bypass
  // via a safe A record paired with a private AAAA record.
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (ipv4ToInt(host) === null && !host.includes(":")) {
    try {
      const [v4addrs, v6addrs] = await Promise.all([
        dns.promises.resolve4(host).catch(() => []),
        dns.promises.resolve6(host).catch(() => []),
      ]);
      const allAddrs = [...v4addrs, ...v6addrs];
      if (allAddrs.length === 0) return; // hostname no longer resolves — abort
      for (const addr of allAddrs) {
        if (isPrivateIp(addr)) return; // silently abort — DNS rebinding detected
      }
    } catch {
      return; // hostname no longer resolves — abort
    }
  }

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(10_000),
    // Prevent open-redirect bypass: a 302 to http://169.254.169.254/…
    // would bypass hostname validation. "error" makes fetch() reject on
    // any redirect response instead of following it.
    redirect: "error",
  });
}

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
 * @param {Object}  req - Express request
 * @param {Object} res - Express response
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

  // ── 3. Extract and validate optional config (async) ────────────────
  // callbackUrl validation includes DNS resolution, so it must happen
  // BEFORE the synchronous concurrent-run guard to avoid a TOCTOU race
  // (an await between the guard and runRepo.create would let a second
  // request slip through).
  const { dialsConfig, callbackUrl } = req.body || {};

  if (callbackUrl && typeof callbackUrl === "string") {
    const urlErr = await validateCallbackUrl(callbackUrl);
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
      },
      onFailActivity: (err) => ({
        type: "test_run.fail",
        projectId: project.id,
        projectName: project.name,
        detail: `CI/CD run failed: ${classifyError(err, "run").message}`,
      }),
      // Fire optional callback URL with run summary on ANY terminal state
      // (completed, failed, aborted) so CI pipelines always get notified.
      // Uses safeFetchCallback which re-resolves DNS (mitigates rebinding)
      // and blocks redirects (mitigates open-redirect SSRF bypass).
      onComplete: (finishedRun) => {
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
  const statusUrl = `${proto}://${host}/api/projects/${project.id}/trigger/runs/${runId}`;

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
router.get("/projects/:id/trigger/runs/:runId", (req, res) => {
  // ── Authenticate with trigger token ──────────────────────────────────
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

  // ── Resolve project ────────────────────────────────────────────────
  const project = projectRepo.getById(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });

  if (tokenRow.projectId !== project.id) {
    return res.status(403).json({ error: "Token does not belong to this project." });
  }

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
