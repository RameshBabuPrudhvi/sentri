/**
 * @module routes/dashboard
 * @description Dashboard analytics endpoint. Mounted at `/api`.
 *
 * ### Endpoints
 * | Method | Path              | Description                                                |
 * |--------|-------------------|------------------------------------------------------------|
 * | `GET`  | `/api/dashboard`  | Pass rate, defects, flaky tests, MTTR, growth, and more    |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import { classifyFailure } from "../pipeline/feedbackLoop.js";

const router = Router();

router.get("/dashboard", (req, res) => {
  // ACL-001: Scope dashboard data to the user's workspace.
  // Projects are filtered by workspaceId; runs and tests are filtered by
  // the set of project IDs that belong to this workspace.
  const projects = projectRepo.getAll(req.workspaceId);
  const projectIds = projects.map(p => p.id);

  // Scope queries to the user's workspace project IDs at the SQL layer
  // so multi-tenant deployments don't load data from other workspaces.
  const runs = runRepo.getWithResultsByProjectIds(projectIds);
  const tests = testRepo.getAllByProjectIds(projectIds);
  // Only fetch activity types needed for dashboard counters (not all activities)
  const generationActivities = activityRepo.getByTypes(["test.create", "test.generate"], {
    workspaceId: req.workspaceId,
  });
  const projectsById = {};
  for (const p of projects) projectsById[p.id] = p;

  // ── Pass rate (last 10 completed test runs) ─────────────────────────────
  const completedTestRuns = runs
    .filter((r) => (r.type === "test_run" || r.type === "run") && r.status === "completed")
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 10);

  const passRate =
    completedTestRuns.length
      ? Math.round(
          (completedTestRuns.reduce((s, r) => s + (r.passed || 0), 0) /
            completedTestRuns.reduce((s, r) => s + (r.total || 1), 0)) *
            100
        )
      : null;

  // ── Chart history — last 20 test runs with results (chronological) ──────
  const history = runs
    .filter((r) => (r.type === "test_run" || r.type === "run") && r.passed != null)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
    .slice(-20)
    .map((r) => ({ passed: r.passed || 0, failed: r.failed || 0, total: r.total || 0, date: r.startedAt }));

  // ── Recent runs — ALL statuses so failures/aborts are visible ───────────
  const recentRuns = runs
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 8)
    .map((r) => {
      const p = projectsById[r.projectId];
      return { id: r.id, projectId: r.projectId, projectName: p?.name || null, type: r.type, status: r.status, startedAt: r.startedAt, passed: r.passed, failed: r.failed, total: r.total };
    });

  // ── Run status distribution ─────────────────────────────────────────────
  const runsByStatus = { completed: 0, completed_empty: 0, failed: 0, aborted: 0, running: 0 };
  for (const r of runs) { if (r.status in runsByStatus) runsByStatus[r.status]++; }

  // ── Test review pipeline ────────────────────────────────────────────────
  const testsByReview = { draft: 0, approved: 0, rejected: 0 };
  for (const t of tests) { const s = t.reviewStatus || "draft"; if (s in testsByReview) testsByReview[s]++; }

  // ── Tests created / generated (today & this week) ───────────────────────
  // Each AI generation logs TWO test.generate activities: one at start
  // (status "running") and one on completion (status "completed" / default).
  // Only count completed activities to avoid double-counting.
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
  let testsCreatedToday = 0, testsCreatedThisWeek = 0, testsGeneratedTotal = 0;
  for (const a of generationActivities) {
    // Skip "running" status entries to avoid double-counting start + completion
    if (a.status === "running") continue;
    testsGeneratedTotal++;
    if (a.createdAt >= todayStart) testsCreatedToday++;
    if (a.createdAt >= weekStart) testsCreatedThisWeek++;
  }

  // ── Tests auto-fixed (feedback loop + self-healing) ─────────────────────
  let testsAutoFixed = 0;
  for (const r of runs) { if (r.feedbackLoop?.improved) testsAutoFixed += r.feedbackLoop.improved; }
  const testIds = tests.map((t) => t.id);
  const healingEntries = healingRepo.countByTestIds(testIds);
  const healingSuccesses = healingRepo.countSuccessesByTestIds(testIds);

  // ── Average run duration (completed test runs) ──────────────────────────
  const durations = completedTestRuns.filter((r) => r.duration > 0).map((r) => r.duration);
  const avgRunDurationMs = durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null;

  // ── Defect / failure category breakdown (across all test run results) ───
  const defectBreakdown = { SELECTOR_ISSUE: 0, NAVIGATION_FAIL: 0, TIMEOUT: 0, ASSERTION_FAIL: 0, UNKNOWN: 0 };
  const testResultStatuses = {};   // testId → Set<"passed"|"failed">
  const testRunResults = runs.filter((r) => (r.type === "test_run" || r.type === "run") && r.results?.length);
  for (const r of testRunResults) {
    for (const result of r.results) {
      if (!testResultStatuses[result.testId]) testResultStatuses[result.testId] = new Set();
      if (result.status) testResultStatuses[result.testId].add(result.status);
      if (result.status === "failed" && result.error) {
        const cat = classifyFailure(result.error);
        if (cat in defectBreakdown) defectBreakdown[cat]++;
        else defectBreakdown.UNKNOWN++;
      }
    }
  }

  // ── Flaky test count (tests with both "passed" and "failed" across runs) ─
  let flakyTestCount = 0;
  for (const statuses of Object.values(testResultStatuses)) {
    if (statuses.has("passed") && statuses.has("failed")) flakyTestCount++;
  }

  // ── Test growth — cumulative test count per week (last 8 weeks) ─────────
  const GROWTH_WEEKS = 8;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const growthStart = new Date(now.getTime() - GROWTH_WEEKS * weekMs);
  const weekBuckets = {};
  for (let i = 0; i < GROWTH_WEEKS; i++) {
    const d = new Date(growthStart.getTime() + i * weekMs);
    const key = d.toISOString().slice(0, 10);
    weekBuckets[key] = 0;
  }
  for (const a of generationActivities) {
    if (a.status === "running") continue; // skip start entries (same as above)
    if (a.createdAt < growthStart.toISOString()) continue;
    const aTime = new Date(a.createdAt).getTime();
    for (let i = GROWTH_WEEKS - 1; i >= 0; i--) {
      const bucketStart = growthStart.getTime() + i * weekMs;
      if (aTime >= bucketStart) {
        const key = new Date(bucketStart).toISOString().slice(0, 10);
        weekBuckets[key] = (weekBuckets[key] || 0) + 1;
        break;
      }
    }
  }
  const testGrowth = [];
  let cumulative = tests.length;
  const sortedKeys = Object.keys(weekBuckets).sort();
  const totalRecent = sortedKeys.reduce((s, k) => s + weekBuckets[k], 0);
  cumulative = Math.max(0, tests.length - totalRecent);
  for (const key of sortedKeys) {
    cumulative += weekBuckets[key];
    testGrowth.push({ week: key, count: cumulative });
  }

  // ── MTTR — mean time to recovery (failed → passed) ─────────────────────
  const chronologicalRuns = runs
    .filter((r) => (r.type === "test_run" || r.type === "run") && r.results?.length && r.startedAt)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const lastFailTime = {};
  const recoveryDeltas = [];
  for (const r of chronologicalRuns) {
    for (const result of r.results) {
      if (result.status === "failed") {
        lastFailTime[result.testId] = r.startedAt;
      } else if (result.status === "passed" && lastFailTime[result.testId]) {
        const delta = new Date(r.startedAt) - new Date(lastFailTime[result.testId]);
        if (delta > 0) recoveryDeltas.push(delta);
        delete lastFailTime[result.testId];
      }
    }
  }
  const mttrMs = recoveryDeltas.length
    ? Math.round(recoveryDeltas.reduce((s, d) => s + d, 0) / recoveryDeltas.length)
    : null;

  res.json({
    totalProjects: projects.length,
    totalTests: tests.length,
    totalRuns: runs.length,
    totalActivities: activityRepo.countFiltered({ workspaceId: req.workspaceId }),
    passRate,
    history,
    recentRuns,
    runsByStatus,
    testsByReview,
    testsCreatedToday,
    testsCreatedThisWeek,
    testsGeneratedTotal,
    testsAutoFixed,
    healingEntries,
    healingSuccesses,
    avgRunDurationMs,
    defectBreakdown,
    flakyTestCount,
    testGrowth,
    mttrMs,
  });
});

export default router;
