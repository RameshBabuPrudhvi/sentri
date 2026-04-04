/**
 * system.js — Health, system info, activities, data management, test-connection
 *
 * Mounted at /api in index.js (except /health which is mounted at root)
 */

import { Router } from "express";
import { getDb } from "../db.js";
import { logActivity } from "../utils/activityLogger.js";

const router = Router();

// ─── Activities ───────────────────────────────────────────────────────────────

router.get("/activities", (req, res) => {
  const db = getDb();
  let activities = Object.values(db.activities)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (req.query.type) {
    activities = activities.filter(a => a.type === req.query.type);
  }
  if (req.query.projectId) {
    activities = activities.filter(a => a.projectId === req.query.projectId);
  }

  const limit = parseInt(req.query.limit, 10) || 200;
  res.json(activities.slice(0, limit));
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
  const db = getDb();
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

  const projects = Object.values(db.projects);
  const tests    = Object.values(db.tests);
  const runs     = Object.values(db.runs);
  const activities = Object.values(db.activities);
  const healingEntries = Object.keys(db.healingHistory || {}).length;

  res.json({
    projects:     projects.length,
    tests:        tests.length,
    runs:         runs.length,
    activities:   activities.length,
    healingEntries,
    approvedTests: tests.filter(t => t.reviewStatus === "approved").length,
    draftTests:    tests.filter(t => t.reviewStatus === "draft").length,
    uptime:        Math.floor(process.uptime()),
    nodeVersion:   process.version,
    playwrightVersion,
    memoryMB:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

// ─── Data Management ──────────────────────────────────────────────────────────

router.delete("/data/runs", (req, res) => {
  const db = getDb();
  const count = Object.keys(db.runs).length;
  for (const key of Object.keys(db.runs)) delete db.runs[key];
  logActivity({ type: "settings.update", detail: `Cleared ${count} run(s)` });
  res.json({ ok: true, cleared: count });
});

router.delete("/data/activities", (req, res) => {
  const db = getDb();
  const count = Object.keys(db.activities).length;
  for (const key of Object.keys(db.activities)) delete db.activities[key];
  res.json({ ok: true, cleared: count });
});

router.delete("/data/healing", (req, res) => {
  const db = getDb();
  const count = Object.keys(db.healingHistory || {}).length;
  if (db.healingHistory) {
    for (const key of Object.keys(db.healingHistory)) delete db.healingHistory[key];
  }
  logActivity({ type: "settings.update", detail: `Cleared ${count} healing history entries` });
  res.json({ ok: true, cleared: count });
});

export default router;
