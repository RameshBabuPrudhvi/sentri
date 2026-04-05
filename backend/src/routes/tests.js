/**
 * tests.js — Test CRUD, AI generation, single-test run, review, and bulk routes
 *
 * Mounted at /api in index.js
 */

import { Router } from "express";
import { getDb } from "../db.js";
import { saveDb } from "../db.js";
import { generateTestId, generateRunId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { runWithAbort } from "../utils/runWithAbort.js";
import { hasProvider } from "../aiProvider.js";
import { resolveDialsPrompt, resolveDialsConfig } from "../testDials.js";
import { generateSingleTest } from "../crawler.js";
import { runTests } from "../testRunner.js"; // thin orchestrator — delegates to runner/ modules
import { buildJUnitXml, buildXrayJson, buildTestRailCsv } from "../utils/exportFormats.js";

const router = Router();

// ─── Test CRUD ────────────────────────────────────────────────────────────────

router.get("/projects/:id/tests", (req, res) => {
  const db = getDb();
  const tests = Object.values(db.tests).filter((t) => t.projectId === req.params.id);
  res.json(tests);
});

router.get("/tests", (req, res) => {
  const db = getDb();
  res.json(Object.values(db.tests));
});

router.get("/tests/:testId", (req, res) => {
  const db = getDb();
  const test = db.tests[req.params.testId];
  if (!test) return res.status(404).json({ error: "not found" });
  res.json(test);
});

// PATCH /api/tests/:testId — persist user-edited steps (and optionally other fields)
router.patch("/tests/:testId", async (req, res) => {
  const db = getDb();
  const test = db.tests[req.params.testId];
  if (!test) return res.status(404).json({ error: "not found" });

  const { steps, name, description, priority, regenerateCode, playwrightCode, linkedIssueKey, tags } = req.body;

  if (typeof name === "string")        test.name        = name.trim();
  if (typeof description === "string") test.description = description.trim();
  if (typeof priority === "string")    test.priority    = priority;
  // Traceability fields
  if (typeof linkedIssueKey === "string") test.linkedIssueKey = linkedIssueKey.trim() || null;
  if (Array.isArray(tags)) test.tags = tags.map(t => String(t).trim()).filter(Boolean);
  if (typeof playwrightCode === "string") {
    if (test.playwrightCode && test.playwrightCode !== playwrightCode) {
      test.playwrightCodePrev = test.playwrightCode;
    }
    test.playwrightCode = playwrightCode;
  }

  const stepsChanged = Array.isArray(steps) &&
    JSON.stringify(steps) !== JSON.stringify(test.steps);

  if (Array.isArray(steps)) test.steps = steps;

  test.updatedAt = new Date().toISOString();

  let codeRegeneratedNow = false;

  if (regenerateCode && hasProvider() && Array.isArray(test.steps) && test.steps.length > 0) {
    try {
      const project = db.projects[test.projectId];
      const appUrl = project?.url || test.sourceUrl || "";
      const { generateText, parseJSON } = await import("../aiProvider.js");

      const codePrompt = `You are a Playwright automation expert. Convert the following QA test steps into a complete, runnable Playwright test.

Test Name: ${test.name}
Application URL: ${appUrl}
Test Steps:
${test.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Requirements:
- MUST start with: await page.goto('${appUrl}')
- Use role-based selectors: getByRole(), getByLabel(), getByText(), getByPlaceholder()
- Add page.waitForLoadState() after each navigation
- Include at least 3 meaningful expect() assertions
- Do NOT include import statements at the top — test/expect are provided externally

Return ONLY valid JSON with no markdown fences:
{
  "playwrightCode": "test('${test.name}', async ({ page }) => {\\n  // full test implementation\\n});"
}`;

      const codeRaw = await generateText(codePrompt);
      let pwCode = null;
      try {
        const parsed = parseJSON(codeRaw);
        pwCode = typeof parsed.playwrightCode === "string" ? parsed.playwrightCode : null;
      } catch {
        if (codeRaw.includes("test(") && codeRaw.includes("async")) {
          pwCode = codeRaw.trim();
        }
      }
      if (pwCode) {
        if (test.playwrightCode && test.playwrightCode !== pwCode) {
          test.playwrightCodePrev = test.playwrightCode;
        }
        test.playwrightCode = pwCode;
        test.codeRegeneratedAt = new Date().toISOString();
        codeRegeneratedNow = true;
      }
    } catch (err) {
      console.error("[PATCH test] code regeneration failed:", err.message);
    }
  }

  const project = db.projects[test.projectId];
  logActivity({
    type: stepsChanged && regenerateCode ? "test.regenerate" : "test.edit",
    projectId: test.projectId,
    projectName: project?.name || null,
    testId: test.id,
    testName: test.name,
    detail: stepsChanged
      ? `Steps updated (${test.steps.length} steps)${codeRegeneratedNow ? " — Playwright code regenerated" : ""}`
      : "Test metadata updated",
  });

  const response = { ...test };
  if (regenerateCode && !codeRegeneratedNow) {
    response._codeStale = true;
  }

  res.json(response);
});

// ── Manual test creation ──────────────────────────────────────────────────────
router.post("/projects/:id/tests", (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "project not found" });

  const { name, description, steps, playwrightCode, priority, type } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  const testId = generateTestId(db);
  const test = {
    id: testId,
    projectId: project.id,
    name: name.trim(),
    description: description?.trim() || "",
    steps: Array.isArray(steps) ? steps : [],
    playwrightCode: playwrightCode || null,
    priority: priority || "medium",
    type: type || "manual",
    sourceUrl: project.url,
    pageTitle: project.name,
    createdAt: new Date().toISOString(),
    lastResult: null,
    lastRunAt: null,
    qualityScore: null,
    isJourneyTest: false,
    reviewStatus: "draft",
    reviewedAt: null,
    // Match shape of AI-generated tests so all pipeline stages work uniformly
    promptVersion: null,
    modelUsed: null,
    linkedIssueKey: null,
    tags: [],
  };

  db.tests[testId] = test;

  logActivity({
    type: "test.create", projectId: project.id, projectName: project.name,
    testId, testName: test.name,
    detail: `Manual test created — "${test.name}"`,
  });

  res.status(201).json(test);
});

router.delete("/projects/:id/tests/:testId", (req, res) => {
  const db = getDb();
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  const project = db.projects[req.params.id];
  logActivity({
    type: "test.delete", projectId: req.params.id, projectName: project?.name || null,
    testId: req.params.testId, testName: test.name,
    detail: `Test deleted — "${test.name}"`,
  });
  delete db.tests[req.params.testId];
  res.json({ ok: true });
});

// ─── AI-powered test generation (pipeline-based) ──────────────────────────────

router.post("/projects/:id/tests/generate", async (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "project not found" });

  const { name, description, dialsConfig } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  // Sanitise name: strip prompt-injection markers (same regex as description/customInstructions)
  const cleanName = name.trim()
    .replace(/^(SYSTEM|ASSISTANT|USER|HUMAN|AI)\s*:/gim, "")
    .replace(/```/g, "")
    .trim();
  if (!cleanName) return res.status(400).json({ error: "name is required" });

  // ── Prompt guardrails ────────────────────────────────────────────────────
  // Cap description at 50 KB to prevent context window overflow.
  // The frontend caps total attachments at 45 KB, leaving headroom for the
  // user's typed description. 50 KB of text is ~12K tokens.
  const MAX_DESCRIPTION_LENGTH = 50_000;
  const rawDescription = (description || "").trim();
  if (rawDescription.length > MAX_DESCRIPTION_LENGTH) {
    return res.status(400).json({
      error: `Description is too long (${Math.round(rawDescription.length / 1000)}KB). Maximum is ${MAX_DESCRIPTION_LENGTH / 1000}KB. Try removing large attachments.`,
    });
  }

  // Sanitise description: strip prompt-injection markers the same way
  // testDials.js sanitises customInstructions. Attachment content from the
  // frontend is concatenated into this field, so it's the main free-text vector.
  const cleanDescription = rawDescription
    .replace(/^(SYSTEM|ASSISTANT|USER|HUMAN|AI)\s*:/gim, "")
    .replace(/```/g, "")
    .trim();
  const dialsPrompt = resolveDialsPrompt(dialsConfig);
  const validatedGenDials = resolveDialsConfig(dialsConfig);
  // Default to "one" for the generate endpoint (user-requested tests)
  // to preserve the original contract of generating exactly 1 test.
  // The crawl endpoint defaults to "ai_decides" which generates 5-8 tests per page.
  // Use strict equality — "ai_decides" is truthy so `|| "one"` would never trigger.
  const rawTestCount = validatedGenDials?.testCount;
  const testCount = (rawTestCount && rawTestCount !== "ai_decides") ? rawTestCount : "one";

  if (!hasProvider()) {
    return res.status(503).json({
      error: "No AI provider configured. Add an API key in Settings to use AI test generation.",
    });
  }

  const runId = generateRunId(db);
  const run = {
    id: runId,
    projectId: project.id,
    type: "generate",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    tests: [],
    pagesFound: 0,
    generateInput: { name: cleanName, description: cleanDescription },
    // Prompt audit trail — stored on every run for compliance, debugging, cost attribution
    promptAudit: {
      descriptionLength: cleanDescription.length,
      dialsConfigSummary: validatedGenDials ? {
        approach: validatedGenDials.approach,
        testCount: validatedGenDials.testCount,
        format: validatedGenDials.format,
        perspectives: validatedGenDials.perspectives?.length || 0,
        quality: validatedGenDials.quality?.length || 0,
        hasCustomInstructions: !!(validatedGenDials.customInstructions),
      } : null,
      requestedAt: new Date().toISOString(),
    },
  };
  db.runs[runId] = run;
saveDb();
  logActivity({
    type: "test.generate", projectId: project.id, projectName: project.name,
    detail: `Test generation pipeline started for "${cleanName}"`, status: "running",
  });

  res.status(202).json({ runId });

  runWithAbort(runId, run,
    (signal) => generateSingleTest(project, run, db, {
      name: cleanName,
      description: cleanDescription,
      dialsPrompt,
      testCount,
      signal,
    }),
    {
      onSuccess: (createdTestIds) => logActivity({
        type: "test.generate", projectId: project.id, projectName: project.name,
        detail: `Test generation completed — ${createdTestIds.length} test(s) created for "${cleanName}"`,
      }),
      onFailActivity: (err) => ({
        type: "test.generate", projectId: project.id, projectName: project.name,
        detail: `Test generation failed for "${cleanName}" — ${err.message}`,
      }),
    },
  );
});

// ── Run a single test by ID ───────────────────────────────────────────────────
router.post("/tests/:testId/run", async (req, res) => {
  const db = getDb();
  const test = db.tests[req.params.testId];
  if (!test) return res.status(404).json({ error: "test not found" });

  const project = db.projects[test.projectId];
  if (!project) return res.status(404).json({ error: "project not found" });

  const runId = generateRunId(db);
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
    total: 1,
    testQueue: [{ id: test.id, name: test.name, steps: test.steps || [] }],
  };
  db.runs[runId] = run;
saveDb();
  logActivity({
    type: "test_run.start", projectId: project.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Single test run started — "${test.name}"`, status: "running",
  });

  runWithAbort(runId, run,
    (signal) => runTests(project, [test], run, db, { signal }),
    {
      onSuccess: () => logActivity({
        type: "test_run.complete", projectId: project.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Single test completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
      }),
      onFailActivity: (err) => ({
        type: "test_run.fail", projectId: project.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Single test failed: ${err.message}`,
      }),
    },
  );

  res.json({ runId });
});

// ─── Test Review: Approve / Reject / Restore / Bulk ──────────────────────────

router.patch("/projects/:id/tests/:testId/approve", (req, res) => {
  const db = getDb();
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  test.reviewStatus = "approved";
  test.reviewedAt = new Date().toISOString();
  const project = db.projects[req.params.id];
  logActivity({
    type: "test.approve", projectId: req.params.id, projectName: project?.name || null,
    testId: test.id, testName: test.name,
    detail: `Test approved — "${test.name}"`,
  });
  res.json(test);
});

router.patch("/projects/:id/tests/:testId/reject", (req, res) => {
  const db = getDb();
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  test.reviewStatus = "rejected";
  test.reviewedAt = new Date().toISOString();
  const project = db.projects[req.params.id];
  logActivity({
    type: "test.reject", projectId: req.params.id, projectName: project?.name || null,
    testId: test.id, testName: test.name,
    detail: `Test rejected — "${test.name}"`,
  });
  res.json(test);
});

router.patch("/projects/:id/tests/:testId/restore", (req, res) => {
  const db = getDb();
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  test.reviewStatus = "draft";
  test.reviewedAt = null;
  const project = db.projects[req.params.id];
  logActivity({
    type: "test.restore", projectId: req.params.id, projectName: project?.name || null,
    testId: test.id, testName: test.name,
    detail: `Test restored to draft — "${test.name}"`,
  });
  res.json(test);
});

// NOTE: bulk must be declared BEFORE :testId wildcard routes to avoid conflict
router.post("/projects/:id/tests/bulk", (req, res) => {
  const db = getDb();
  const { testIds, action } = req.body;
  if (!testIds || !Array.isArray(testIds) || !["approve", "reject", "restore", "delete"].includes(action))
    return res.status(400).json({ error: "testIds[] and valid action required" });

  if (action === "delete") {
    const deleted = [];
    testIds.forEach((tid) => {
      const test = db.tests[tid];
      if (test && test.projectId === req.params.id) {
        deleted.push({ id: test.id, name: test.name });
        delete db.tests[tid];
      }
    });
    if (deleted.length) {
      const project = db.projects[req.params.id];
      logActivity({
        type: "test.bulk_delete", projectId: req.params.id, projectName: project?.name || null,
        detail: `Bulk delete — ${deleted.length} test${deleted.length !== 1 ? "s" : ""}`,
      });
    }
    return res.json({ deleted: deleted.length, tests: deleted });
  }

  const statusMap = { approve: "approved", reject: "rejected", restore: "draft" };
  const updated = [];
  testIds.forEach((tid) => {
    const test = db.tests[tid];
    if (test && test.projectId === req.params.id) {
      test.reviewStatus = statusMap[action];
      test.reviewedAt = action === "restore" ? null : new Date().toISOString();
      updated.push(test);
    }
  });
  if (updated.length) {
    const project = db.projects[req.params.id];
    logActivity({
      type: `test.bulk_${action}`, projectId: req.params.id, projectName: project?.name || null,
      detail: `Bulk ${action} — ${updated.length} test${updated.length !== 1 ? "s" : ""}`,
    });
  }
  res.json({ updated: updated.length, tests: updated });
});

// ─── Export endpoints — enterprise test management integration ────────────────

// GET /api/projects/:id/tests/export/junit — JUnit XML for CI pipelines
router.get("/projects/:id/tests/export/junit", (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = Object.values(db.tests).filter(t => t.projectId === req.params.id);
  // Optional filter: ?status=approved to export only approved tests
  const status = req.query.status;
  const filtered = status ? tests.filter(t => t.reviewStatus === status) : tests;

  const xml = buildJUnitXml(filtered, { suiteName: project.name, projectUrl: project.url });
  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Content-Disposition", `attachment; filename="sentri-${project.name.replace(/[^a-z0-9]+/gi, "-")}-tests.xml"`);
  res.send(xml);
});

// GET /api/projects/:id/tests/export/xray — Xray JSON for Jira import
router.get("/projects/:id/tests/export/xray", (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = Object.values(db.tests).filter(t => t.projectId === req.params.id);
  const status = req.query.status;
  const filtered = status ? tests.filter(t => t.reviewStatus === status) : tests;

  // Extract project key from linked issues or use project name as fallback
  const projectKey = filtered.find(t => t.linkedIssueKey)?.linkedIssueKey?.split("-")[0] || "PROJ";
  const json = buildXrayJson(filtered, { projectKey });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="sentri-${project.name.replace(/[^a-z0-9]+/gi, "-")}-xray.json"`);
  res.send(json);
});

// GET /api/projects/:id/tests/export/testrail — TestRail CSV for bulk import
router.get("/projects/:id/tests/export/testrail", (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = Object.values(db.tests).filter(t => t.projectId === req.params.id);
  const status = req.query.status;
  const filtered = status ? tests.filter(t => t.reviewStatus === status) : tests;

  const csv = buildTestRailCsv(filtered);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="sentri-${project.name.replace(/[^a-z0-9]+/gi, "-")}-testrail.csv"`);
  res.send(csv);
});

// GET /api/projects/:id/tests/traceability — traceability matrix (requirement → test → result)
router.get("/projects/:id/tests/traceability", (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = Object.values(db.tests).filter(t => t.projectId === req.params.id);

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
