/**
 * @module routes/system
 * @description System info, activities, data management, and URL reachability. Mounted at `/api/v1` (INF-005).
 *
 * All queries are scoped to the authenticated user's workspace (ACL-001).
 *
 * ### Endpoints
 * | Method   | Path                          | Description                                | Min Role  |
 * |----------|-------------------------------|--------------------------------------------|-----------|
 * | `GET`    | `/api/v1/activities`          | Activity log (filterable by type, project)  | viewer    |
 * | `POST`   | `/api/v1/test-connection`     | Verify a URL is reachable (SSRF-protected)  | qa_lead   |
 * | `GET`    | `/api/v1/system`              | Uptime, Node/Playwright versions, DB counts | viewer    |
 * | `POST`   | `/api/v1/system/client-error` | Log a frontend crash report                 | viewer    |
 * | `DELETE` | `/api/v1/data/runs`           | Clear all run history (incl. soft-deleted)  | admin     |
 * | `DELETE` | `/api/v1/data/activities`     | Clear activity log                          | admin     |
 * | `DELETE` | `/api/v1/data/healing`        | Clear self-healing history                  | admin     |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import { logActivity } from "../utils/activityLogger.js";
import { actor } from "../utils/actor.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { activeTaskCount } from "../scheduler.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

// ─── Activities ───────────────────────────────────────────────────────────────

router.get("/activities", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 200;
  const activities = activityRepo.getFiltered({
    type: req.query.type || undefined,
    projectId: req.query.projectId || undefined,
    workspaceId: req.workspaceId,
    limit,
  });
  res.json(activities);
});

// ─── URL reachability test ────────────────────────────────────────────────────

router.post("/test-connection", requireRole("qa_lead"), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "URL must use http or https protocol" });
  }
  // SSRF protection: block loopback, link-local, and private IP ranges.
  //
  // Dev escape hatch — when `ALLOW_PRIVATE_URLS=true`, skip the SSRF check so
  // developers can Test against `http://localhost:3000`, Dockerised stacks, or
  // internal staging hostnames (mirrors the `SKIP_EMAIL_VERIFICATION` pattern).
  // Never set this in production — it permits SSRF to cloud metadata endpoints
  // (169.254.169.254), databases on the local network, etc.
  if (process.env.ALLOW_PRIVATE_URLS === "true") {
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10000) });
      return res.json({ ok: true, status: response.status });
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  function extractMappedIPv4(host) {
    const dottedMatch = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (dottedMatch) return dottedMatch[1];
    const hexMatch = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return null;
  }

  function isPrivateIPv4(ip) {
    return (
      /^127\.\d+\.\d+\.\d+$/.test(ip) ||
      /^10\.\d+\.\d+\.\d+$/.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ip) ||
      /^192\.168\.\d+\.\d+$/.test(ip) ||
      ip === "0.0.0.0" ||
      ip === "169.254.169.254"
    );
  }

  const mappedIPv4 = extractMappedIPv4(hostname);
  const blocked =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isPrivateIPv4(hostname) ||
    (mappedIPv4 && isPrivateIPv4(mappedIPv4)) ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "::1" ||
    (/^::ffff:/i.test(hostname) && mappedIPv4 === null) ||
    hostname === "169.254.169.254" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".internal") ||
    /^fe80:/i.test(hostname) ||
    /^fd[0-9a-f]{2}:/i.test(hostname) ||
    /^fc[0-9a-f]{2}:/i.test(hostname);
  if (blocked) {
    return res.status(400).json({ error: "URL must not point to localhost, private, or internal addresses" });
  }
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10000) });
    res.json({ ok: true, status: response.status });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ─── System Info ──────────────────────────────────────────────────────────────

router.get("/system", async (req, res) => {
  let playwrightVersion = null;
  try {
    const pwPkg = await import("playwright/package.json", { with: { type: "json" } }).catch(() => null);
    playwrightVersion = pwPkg?.default?.version || null;
  } catch { /* ignore */ }

  if (!playwrightVersion) {
    try {
      const { createRequire } = await import("module");
      const require = createRequire(import.meta.url);
      const pwPkg = require("playwright/package.json");
      playwrightVersion = pwPkg.version;
    } catch { /* ignore */ }
  }

  const projects = projectRepo.getAll(req.workspaceId);
  const projectIds = projects.map((p) => p.id);
  // Use SQL-level counts instead of loading all test rows into memory.
  const testCount = testRepo.countByProjectIds(projectIds);
  const approvedTests = testRepo.countApprovedByProjectIds(projectIds);
  const draftTests = testRepo.countDraftByProjectIds(projectIds);
  // Healing counts need test IDs — use the lightweight ID-only query.
  const testIds = testRepo.getAllIdsByProjectIdsIncludeDeleted(projectIds);

  const projectCount = projects.length;
  const runCount = runRepo.countByProjectIds(projectIds);
  const activityCount = activityRepo.countFiltered({ workspaceId: req.workspaceId });
  const healingEntries = healingRepo.countByTestIds(testIds);

  res.json({
    projects:     projectCount,
    tests:        testCount,
    runs:         runCount,
    activities:   activityCount,
    healingEntries,
    approvedTests,
    draftTests,
    uptime:        Math.floor(process.uptime()),
    nodeVersion:   process.version,
    playwrightVersion,
    memoryMB:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    activeSchedules: activeTaskCount(),
  });
});

// ─── Client error reporting ───────────────────────────────────────────────────
// Receives crash reports from the frontend ErrorBoundary (componentDidCatch).
// Logs the error server-side so crashes are visible in backend logs even when
// the user doesn't report them. The endpoint intentionally does minimal work
// and always returns 200 — it must never throw back to the already-crashed UI.

router.post("/system/client-error", (req, res) => {
  const { message, stack, componentStack, url } = req.body || {};
  console.error(formatLogLine("error", null,
    `[client-error] ${message || "Unknown error"} at ${url || "unknown URL"}` +
    (stack ? `\n${stack}` : "") +
    (componentStack ? `\nComponent stack:${componentStack}` : ""),
  ));
  res.json({ ok: true });
});

// ─── Data Management ──────────────────────────────────────────────────────────

router.delete("/data/runs", requireRole("admin"), (req, res) => {
  const projects = projectRepo.getAllIncludeDeleted(req.workspaceId);
  const count = projects.reduce((sum, p) => sum + runRepo.hardDeleteByProjectId(p.id).length, 0);
  logActivity({ ...actor(req), type: "settings.update", detail: `Cleared ${count} run(s)` });
  res.json({ ok: true, cleared: count });
});

router.delete("/data/activities", requireRole("admin"), (req, res) => {
  const count = activityRepo.clearByWorkspaceId(req.workspaceId);
  res.json({ ok: true, cleared: count });
});

router.delete("/data/healing", requireRole("admin"), (req, res) => {
  const projectIds = projectRepo.getAllIncludeDeleted(req.workspaceId).map((p) => p.id);
  const testIds = testRepo.getAllIdsByProjectIdsIncludeDeleted(projectIds);
  const count = healingRepo.countByTestIds(testIds);
  healingRepo.deleteByTestIds(testIds);
  logActivity({ ...actor(req), type: "settings.update", detail: `Cleared ${count} healing history entries` });
  res.json({ ok: true, cleared: count });
});

export default router;
