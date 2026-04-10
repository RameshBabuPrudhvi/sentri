/**
 * @module routes/system
 * @description System info, activities, data management, and URL reachability. Mounted at `/api`.
 *
 * ### Endpoints
 * | Method   | Path                     | Description                                |
 * |----------|--------------------------|--------------------------------------------|
 * | `GET`    | `/api/activities`        | Activity log (filterable by type, project)  |
 * | `POST`   | `/api/test-connection`   | Verify a URL is reachable (SSRF-protected)  |
 * | `GET`    | `/api/system`            | Uptime, Node/Playwright versions, DB counts |
 * | `DELETE` | `/api/data/runs`         | Clear all run history                       |
 * | `DELETE` | `/api/data/activities`   | Clear activity log                          |
 * | `DELETE` | `/api/data/healing`      | Clear self-healing history                  |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import { logActivity } from "../utils/activityLogger.js";

const router = Router();

// ─── Activities ───────────────────────────────────────────────────────────────

router.get("/activities", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 200;
  const activities = activityRepo.getFiltered({
    type: req.query.type || undefined,
    projectId: req.query.projectId || undefined,
    limit,
  });
  res.json(activities);
});

// ─── URL reachability test ────────────────────────────────────────────────────

router.post("/test-connection", async (req, res) => {
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
  // SSRF protection: block loopback, link-local, and private IP ranges
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

  const projectCount   = projectRepo.count();
  const testCount      = testRepo.count();
  const runCount       = runRepo.count();
  const activityCount  = activityRepo.count();
  const healingEntries = healingRepo.count();
  const approvedTests  = testRepo.countApproved();
  const draftTests     = testRepo.countDraft();

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
  });
});

// ─── Data Management ──────────────────────────────────────────────────────────

router.delete("/data/runs", (req, res) => {
  const count = runRepo.clearAll();
  logActivity({ type: "settings.update", detail: `Cleared ${count} run(s)` });
  res.json({ ok: true, cleared: count });
});

router.delete("/data/activities", (req, res) => {
  const count = activityRepo.clearAll();
  res.json({ ok: true, cleared: count });
});

router.delete("/data/healing", (req, res) => {
  const count = healingRepo.clearAll();
  logActivity({ type: "settings.update", detail: `Cleared ${count} healing history entries` });
  res.json({ ok: true, cleared: count });
});

export default router;
