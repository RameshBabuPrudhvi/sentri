/**
 * @module routes/tests
 * @description Test CRUD, AI generation, single-test run, review, bulk actions, and export. Mounted at `/api/v1` (INF-005).
 *
 * ### Endpoints
 * | Method   | Path                                             | Description                         |
 * |----------|--------------------------------------------------|-------------------------------------|
 * | `GET`    | `/api/v1/projects/:id/tests`                     | List tests for a project            |
 * | `GET`    | `/api/v1/tests`                                  | List all tests                      |
 * | `GET`    | `/api/v1/tests/:testId`                          | Get a single test                   |
 * | `PATCH`  | `/api/v1/tests/:testId`                          | Edit test (steps, name, code, etc.) |
 * | `POST`   | `/api/v1/projects/:id/tests`                     | Create a manual test (Draft)        |
 * | `DELETE` | `/api/v1/projects/:id/tests/:testId`             | Delete a test                       |
 * | `POST`   | `/api/v1/projects/:id/tests/generate`            | AI-generate test(s) from description|
 * | `POST`   | `/api/v1/tests/:testId/run`                      | Run a single test                   |
 * | `PATCH`  | `/api/v1/projects/:id/tests/:testId/approve`     | Approve (Draft → Approved)          |
 * | `PATCH`  | `/api/v1/projects/:id/tests/:testId/reject`      | Reject                              |
 * | `PATCH`  | `/api/v1/projects/:id/tests/:testId/restore`     | Restore to Draft                    |
 * | `POST`   | `/api/v1/projects/:id/tests/bulk`                | Bulk approve/reject/restore/delete  |
 * | `GET`    | `/api/v1/projects/:id/tests/counts`              | Per-status test counts              |
 * | `GET`    | `/api/v1/projects/:id/tests/export/zephyr`       | Zephyr Scale CSV export             |
 * | `GET`    | `/api/v1/projects/:id/tests/export/testrail`     | TestRail CSV export                 |
 * | `GET`    | `/api/v1/projects/:id/tests/traceability`        | Traceability matrix                 |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import { generateTestId, generateRunId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { runWithAbort } from "../utils/runWithAbort.js";
import { classifyError } from "../utils/errorClassifier.js";
import { hasProvider, isLocalProvider } from "../aiProvider.js";
import { resolveDialsPrompt, resolveDialsConfig } from "../testDials.js";
import { generateFromUserDescription } from "../crawler.js";
import { runTests } from "../testRunner.js"; // thin orchestrator — delegates to runner/ modules
import { buildZephyrCsv, buildTestRailCsv } from "../utils/exportFormats.js";
import { validateTestPayload, validateTestUpdate, validateBulkAction } from "../utils/validate.js";
import { isApiTest } from "../runner/codeParsing.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { aiGenerationLimiter, expensiveOpLimiter } from "../middleware/appSetup.js";
import { demoQuota } from "../middleware/demoQuota.js";
import { actor } from "../utils/actor.js";
import { requireRole } from "../middleware/requireRole.js";
import * as baselineRepo from "../database/repositories/baselineRepo.js";
import { acceptBaseline } from "../runner/visualDiff.js";
import { SHOTS_DIR, BASELINES_DIR, resolveBrowser } from "../runner/config.js";
import path from "path";
import fs from "fs";
import { startRecording, stopRecording, getRecording, takeCompletedRecording, actionsToPlaywrightCode, forwardInput } from "../runner/recorder.js";
import { randomUUID } from "crypto";

const router = Router();

// ─── Test CRUD ────────────────────────────────────────────────────────────────

router.get("/projects/:id/tests", (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const { page, pageSize, reviewStatus, category, search, stale } = req.query;
  if (page !== undefined || pageSize !== undefined) {
    const filters = {};
    if (reviewStatus && reviewStatus !== "all") filters.reviewStatus = reviewStatus;
    if (category && category !== "all") filters.category = category;
    if (search) filters.search = search;
    if (stale === "true") filters.stale = true;
    return res.json(testRepo.getByProjectIdPaged(req.params.id, page, pageSize, filters));
  }
  res.json(testRepo.getByProjectId(req.params.id));
});

router.get("/tests", (req, res) => {
  // Scope to the user's workspace by fetching workspace project IDs (ACL-001)
  const wsProjects = projectRepo.getAll(req.workspaceId);
  const projectIds = wsProjects.map(p => p.id);

  const { page, pageSize } = req.query;
  if (page !== undefined || pageSize !== undefined) {
    return res.json(testRepo.getAllPagedByProjectIds(projectIds, page, pageSize));
  }
  res.json(testRepo.getAllByProjectIds(projectIds));
});

router.get("/tests/:testId", (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "not found" });
  // Verify the test's project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(test);
});

// PATCH /api/tests/:testId — persist user-edited steps (and optionally other fields)
router.patch("/tests/:testId", requireRole("qa_lead"), async (req, res) => {
  const validationErr = validateTestUpdate(req.body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "not found" });
  // Verify the test's project belongs to the user's workspace (ACL-001)
  const ownerProject = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!ownerProject) return res.status(404).json({ error: "not found" });

  const { steps, name, description, priority, regenerateCode, previewCode, playwrightCode, linkedIssueKey, tags } = req.body;

  const updates = {};

  if (typeof name === "string")        updates.name        = name.trim();
  if (typeof description === "string") updates.description = description.trim();
  if (typeof priority === "string")    updates.priority    = priority;
  if (typeof linkedIssueKey === "string") updates.linkedIssueKey = linkedIssueKey.trim() || null;
  if (Array.isArray(tags)) updates.tags = tags.map(t => String(t).trim()).filter(Boolean);
  if (typeof playwrightCode === "string") {
    if (test.playwrightCode && test.playwrightCode !== playwrightCode) {
      updates.playwrightCodePrev = test.playwrightCode;
    }
    updates.playwrightCode = playwrightCode;
  }

  const stepsChanged = Array.isArray(steps) &&
    JSON.stringify(steps) !== JSON.stringify(test.steps);

  if (Array.isArray(steps)) updates.steps = steps;

  updates.updatedAt = new Date().toISOString();

  // Any content change (steps, name, description, code, priority) reverts
  // the test to draft so it requires re-approval after editing.
  const contentChanged = stepsChanged
    || (typeof name === "string" && name.trim() !== test.name)
    || (typeof description === "string" && description.trim() !== test.description)
    || (typeof playwrightCode === "string" && playwrightCode !== test.playwrightCode)
    || (typeof priority === "string" && priority !== test.priority);
  if (contentChanged && test.reviewStatus !== "draft") {
    updates.reviewStatus = "draft";
    updates.reviewedAt = null;
  }

  if (typeof playwrightCode === "string") {
    updates.isApiTest = !!(playwrightCode && isApiTest(playwrightCode));
  }

  let codeRegeneratedNow = false;
  let regenerationError = null; // transient — not persisted, only returned in the response
  const currentSteps = updates.steps || test.steps;
  const currentName = updates.name || test.name;

  const shouldRegenerate = (regenerateCode || previewCode) && hasProvider() && Array.isArray(currentSteps) && currentSteps.length > 0;
  let previewResult = null;

  if (shouldRegenerate) {
    try {
      const project = projectRepo.getById(test.projectId);
      const appUrl = project?.url || test.sourceUrl || "";
      const { generateText, parseJSON } = await import("../aiProvider.js");

      // If existing code is available, ask the AI to adapt it to the new steps
      // instead of generating from scratch. This preserves self-healing helpers,
      // comments, and structure — only the changed/removed steps are affected.
      const existingCode = updates.playwrightCode || test.playwrightCode;
      const local = isLocalProvider();

      // Local models (7B) struggle with verbose prompts and JSON output.
      // Use a shorter prompt and request plain code (no JSON wrapper) for Ollama.
      let codePrompt;
      if (existingCode && !local) {
        codePrompt = `You are a Playwright automation expert. The user has edited the test steps. Update the existing Playwright test code to match the new steps.

Test Name: ${currentName}
Application URL: ${appUrl}

PREVIOUS steps:
${(test.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n")}

UPDATED steps:
${currentSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

EXISTING Playwright code:
\`\`\`javascript
${existingCode}
\`\`\`

Requirements:
- Make MINIMAL changes to the existing code — only add, remove, or modify the code sections that correspond to changed or removed steps.
- Keep ALL unchanged step code, comments (// Step N:), helpers (safeClick, safeFill, safeExpect), and structure exactly as-is.
- If a step was removed, remove ONLY its corresponding code block and renumber the remaining "// Step N:" comments.
- If a step was added, insert code for it in the correct position.
- If a step was reworded, update only the affected line(s).
- Do NOT rewrite the entire test from scratch.
- Do NOT include import statements at the top — test/expect are provided externally.

Return ONLY valid JSON with no markdown fences:
{
  "playwrightCode": "test('${currentName}', async ({ page }) => {\\n  // updated test implementation\\n});"
}`;
      } else if (existingCode && local) {
        // Shorter prompt for local models — skip JSON wrapper, request plain code
        codePrompt = `Update this Playwright test to match the new steps. Only change what's needed.

Steps:
${currentSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Current code:
${existingCode}

Return ONLY the updated test code, no explanation.`;
      } else if (!local) {
        codePrompt = `You are a Playwright automation expert. Convert the following QA test steps into a complete, runnable Playwright test.

Test Name: ${currentName}
Application URL: ${appUrl}
Test Steps:
${currentSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Requirements:
- MUST start with: await page.goto('${appUrl}')
- Use role-based selectors: getByRole(), getByLabel(), getByText(), getByPlaceholder()
- Add page.waitForLoadState() after each navigation
- Include at least 3 meaningful expect() assertions
- Do NOT include import statements at the top — test/expect are provided externally

Return ONLY valid JSON with no markdown fences:
{
  "playwrightCode": "test('${currentName}', async ({ page }) => {\\n  // full test implementation\\n});"
}`;
      } else {
        // Shorter prompt for local models — skip JSON wrapper
        codePrompt = `Write a Playwright test for these steps. Start with page.goto('${appUrl}').

Test: ${currentName}
Steps:
${currentSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Return ONLY the test code starting with test('${currentName}', async ({ page }) => {
No imports, no explanation.`;
      }

      const genOpts = local
        ? { maxTokens: 4096, responseFormat: "text" }
        : {};
      const codeRaw = await generateText(codePrompt, genOpts);
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
        if (previewCode) {
          // Preview mode: return generated code without persisting it.
          // The frontend shows a diff panel for the user to accept/edit/discard.
          previewResult = { generatedCode: pwCode, originalCode: existingCode || null };
        } else {
          const currentCode = updates.playwrightCode || test.playwrightCode;
          if (currentCode && currentCode !== pwCode) {
            updates.playwrightCodePrev = currentCode;
          }
          updates.playwrightCode = pwCode;
          updates.isApiTest = !!(pwCode && isApiTest(pwCode));
          updates.codeRegeneratedAt = new Date().toISOString();
          codeRegeneratedNow = true;
        }
      } else {
        // AI returned output that didn't parse as valid code — surface to user
        regenerationError = "Code regeneration produced invalid output. Please try again or edit the code directly via the Source tab.";
      }
    } catch (err) {
      console.error(formatLogLine("error", null, `[PATCH test] code regeneration failed: ${err.message}`));
      // Surface a user-friendly message for timeout errors (common with Ollama)
      if (err.message?.includes("timed out") || err.message?.includes("ECONNREFUSED")) {
        regenerationError = isLocalProvider()
          ? "Code regeneration timed out. Local models may need more time for large tests. Try editing the code directly via the Source tab."
          : "Code regeneration failed. Please try again or edit the code directly via the Source tab.";
      } else {
        regenerationError = "Code regeneration failed. Please try again or edit the code directly via the Source tab.";
      }
    }
  }

  // Persist all updates to SQLite
  testRepo.update(test.id, updates);

  const project = projectRepo.getById(test.projectId);
  logActivity({ ...actor(req),
    type: stepsChanged && (regenerateCode || previewCode) ? "test.regenerate" : "test.edit",
    projectId: test.projectId,
    projectName: project?.name || null,
    testId: test.id,
    testName: updates.name || test.name,
    detail: stepsChanged
      ? `Steps updated (${(updates.steps || test.steps).length} steps)${codeRegeneratedNow ? " — Playwright code regenerated" : ""}`
      : "Test metadata updated",
  });

  // Re-read the updated test from SQLite for the response
  const updatedTest = testRepo.getById(test.id);
  const response = { ...updatedTest };
  if (regenerateCode && !codeRegeneratedNow && !previewCode) {
    response._codeStale = true;
  }
  if (previewResult) {
    response._codePreview = previewResult;
  }
  if (regenerationError) {
    response._regenerationError = regenerationError;
  }

  res.json(response);
});

// ── Manual test creation ──────────────────────────────────────────────────────
router.post("/projects/:id/tests", requireRole("qa_lead"), (req, res) => {
  const validationErr = validateTestPayload(req.body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const { name, description, steps, playwrightCode, priority, type } = req.body;

  const testId = generateTestId();
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
    promptVersion: null,
    modelUsed: null,
    linkedIssueKey: null,
    tags: [],
    workspaceId: project.workspaceId || null,
  };

  testRepo.create(test);

  logActivity({ ...actor(req),
    type: "test.create", projectId: project.id, projectName: project.name,
    testId, testName: test.name,
    detail: `Manual test created — "${test.name}"`,
  });

  res.status(201).json(test);
});

router.delete("/projects/:id/tests/:testId", requireRole("qa_lead"), (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const test = testRepo.getById(req.params.testId);
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  logActivity({ ...actor(req),
    type: "test.delete", projectId: req.params.id, projectName: project?.name || null,
    testId: req.params.testId, testName: test.name,
    detail: `Test moved to recycle bin — "${test.name}"`,
  });
  testRepo.deleteById(req.params.testId);
  res.json({ ok: true });
});

// ─── AI-powered test generation (pipeline-based) ──────────────────────────────

router.post("/projects/:id/tests/generate", requireRole("qa_lead"), demoQuota("generation"), aiGenerationLimiter, async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
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
  // Default to "one" for the description-based generate endpoint so users
  // who don't touch Test Dials get 1 focused test (original behaviour).
  // When the user explicitly selects a testCount dial, that value is used instead.
  // The crawl endpoint defaults to "ai_decides" which generates multiple tests per page.
  // Use strict equality — "ai_decides" is truthy so `|| "one"` would never trigger.
  const rawTestCount = validatedGenDials?.testCount;
  const testCount = (rawTestCount && rawTestCount !== "ai_decides") ? rawTestCount : "one";

  if (!hasProvider()) {
    return res.status(503).json({
      error: "No AI provider configured. Add an API key in Settings to use AI test generation.",
    });
  }

  const runId = generateRunId();
  const run = {
    id: runId,
    projectId: project.id,
    type: "generate",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    tests: [],
    pagesFound: 0,
    generateInput: { name: cleanName, description: cleanDescription, dialsConfig: validatedGenDials || undefined },
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
    workspaceId: project.workspaceId || null,
  };
  runRepo.create(run);
  logActivity({ ...actor(req),
    type: "test.generate", projectId: project.id, projectName: project.name,
    detail: `Test generation pipeline started for "${cleanName}"`, status: "running",
  });

  res.status(202).json({ runId });

  runWithAbort(runId, run,
    (signal) => generateFromUserDescription(project, run, {
      name: cleanName,
      description: cleanDescription,
      dialsPrompt,
      testCount,
      signal,
    }),
    {
      onSuccess: (createdTestIds) => logActivity({ ...actor(req),
        type: "test.generate", projectId: project.id, projectName: project.name,
        detail: `Test generation completed — ${createdTestIds.length} test(s) created for "${cleanName}"`,
      }),
      onFailActivity: (err) => ({
        type: "test.generate", projectId: project.id, projectName: project.name,
        detail: `Test generation failed for "${cleanName}" — ${classifyError(err, "crawl").message}`,
      }),
      actorInfo: actor(req),
    },
  );
});

// ── Run a single test by ID ───────────────────────────────────────────────────
router.post("/tests/:testId/run", requireRole("qa_lead"), demoQuota("run"), expensiveOpLimiter, async (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "test not found" });

  const project = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

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
    total: 1,
    testQueue: [{ id: test.id, name: test.name, steps: test.steps || [] }],
    workspaceId: project.workspaceId || null,
  };
  runRepo.create(run);
  logActivity({ ...actor(req),
    type: "test_run.start", projectId: project.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Single test run started — "${test.name}"`, status: "running",
  });

  runWithAbort(runId, run,
    (signal) => runTests(project, [test], run, { signal }),
    {
      onSuccess: () => logActivity({ ...actor(req),
        type: "test_run.complete", projectId: project.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Single test completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
      }),
      onFailActivity: (err) => ({
        type: "test_run.fail", projectId: project.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Test run failed for "${test.name}" — ${classifyError(err, "run").message}`,
      }),
      actorInfo: actor(req),
    },
  );

  res.json({ runId });
});

// ─── Test Review: Approve / Reject / Restore / Bulk ──────────────────────────

router.patch("/projects/:id/tests/:testId/approve", requireRole("qa_lead"), (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const test = testRepo.getById(req.params.testId);
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  const reviewedAt = new Date().toISOString();
  testRepo.update(test.id, { reviewStatus: "approved", reviewedAt });
  logActivity({ ...actor(req),
    type: "test.approve", projectId: req.params.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Test approved — "${test.name}"`,
  });
  res.json(testRepo.getById(test.id));
});

router.patch("/projects/:id/tests/:testId/reject", requireRole("qa_lead"), (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const test = testRepo.getById(req.params.testId);
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  const reviewedAt = new Date().toISOString();
  testRepo.update(test.id, { reviewStatus: "rejected", reviewedAt });
  logActivity({ ...actor(req),
    type: "test.reject", projectId: req.params.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Test rejected — "${test.name}"`,
  });
  res.json(testRepo.getById(test.id));
});

router.patch("/projects/:id/tests/:testId/restore", requireRole("qa_lead"), (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const test = testRepo.getById(req.params.testId);
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  testRepo.update(test.id, { reviewStatus: "draft", reviewedAt: null });
  logActivity({ ...actor(req),
    type: "test.restore", projectId: req.params.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Test restored to draft — "${test.name}"`,
  });
  res.json(testRepo.getById(test.id));
});

// NOTE: bulk must be declared BEFORE :testId wildcard routes to avoid conflict
router.post("/projects/:id/tests/bulk", requireRole("qa_lead"), (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const validationErr = validateBulkAction(req.body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const { testIds, action } = req.body;

  if (action === "delete") {
    const deleted = [];
    testIds.forEach((tid) => {
      const test = testRepo.getById(tid);
      if (test && test.projectId === req.params.id) {
        deleted.push({ id: test.id, name: test.name });
        testRepo.deleteById(tid);
      }
    });
    if (deleted.length) {
      logActivity({ ...actor(req),
        type: "test.bulk_delete", projectId: req.params.id, projectName: project.name,
        detail: `Bulk delete — ${deleted.length} test${deleted.length !== 1 ? "s" : ""} moved to recycle bin`,
      });
    }
    return res.json({ deleted: deleted.length, tests: deleted });
  }

  const statusMap = { approve: "approved", reject: "rejected", restore: "draft" };
  const reviewedAt = action === "restore" ? null : new Date().toISOString();
  const updated = testRepo.bulkUpdateReviewStatus(testIds, req.params.id, statusMap[action], reviewedAt);

  if (updated.length) {
    for (const test of updated) {
      logActivity({ ...actor(req),
        type: `test.${action}`, projectId: req.params.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Test ${action === "approve" ? "approved" : action === "reject" ? "rejected" : "restored to draft"} (bulk) — "${test.name}"`,
      });
    }
    logActivity({ ...actor(req),
      type: `test.bulk_${action}`, projectId: req.params.id, projectName: project.name,
      detail: `Bulk ${action} — ${updated.length} test${updated.length !== 1 ? "s" : ""}`,
    });
  }
  res.json({ updated: updated.length, tests: updated });
});

// ─── Test counts (lightweight — no row data, just per-status totals) ──────────

router.get("/projects/:id/tests/counts", (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const counts = testRepo.countByReviewStatus(req.params.id);
  res.json({ ...counts, total: counts.draft + counts.approved + counts.rejected });
});

// ─── Export endpoints — enterprise test management integration ────────────────

// GET /api/projects/:id/tests/export/zephyr — Zephyr Scale CSV for test management import
router.get("/projects/:id/tests/export/zephyr", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = testRepo.getByProjectId(req.params.id);
  const status = req.query.status;
  const filtered = status ? tests.filter(t => t.reviewStatus === status) : tests;

  const csv = buildZephyrCsv(filtered);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="sentri-${project.name.replace(/[^a-z0-9]+/gi, "-")}-zephyr.csv"`);
  res.send(csv);
});

// GET /api/projects/:id/tests/export/testrail — TestRail CSV for bulk import
router.get("/projects/:id/tests/export/testrail", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = testRepo.getByProjectId(req.params.id);
  const status = req.query.status;
  const filtered = status ? tests.filter(t => t.reviewStatus === status) : tests;

  const csv = buildTestRailCsv(filtered);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="sentri-${project.name.replace(/[^a-z0-9]+/gi, "-")}-testrail.csv"`);
  res.send(csv);
});

// GET /api/projects/:id/tests/traceability — traceability matrix (requirement → test → result)
router.get("/projects/:id/tests/traceability", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const tests = testRepo.getByProjectId(req.params.id);

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

// ─── DIF-001: Visual regression baselines ────────────────────────────────────
//
// Baselines are the "golden" screenshots subsequent runs diff against. They
// are created lazily on the first run that produces a screenshot for a given
// (testId, stepNumber). Users can accept a fresh capture as the new baseline
// (to acknowledge intentional UI changes) or delete a baseline to regenerate
// it from the next run's output.

/**
 * GET /api/v1/tests/:testId/baselines
 * List all baselines for a test.
 */
router.get("/tests/:testId/baselines", (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "test not found" });
  const project = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "test not found" });
  const requestedBrowser = typeof req.query?.browser === "string" ? req.query.browser : "";
  const browser = requestedBrowser ? resolveBrowser(requestedBrowser).name : "";
  res.json(baselineRepo.getAllByTestId(test.id, browser));
});

/**
 * POST /api/v1/tests/:testId/baselines/:stepNumber/accept
 * Promote a captured screenshot from an earlier run to the new baseline.
 *
 * Body: { runId: string } — the run whose screenshot should become the baseline.
 *   - For stepNumber = 0, the run result's `screenshotPath` is used.
 *   - For stepNumber >= 1, the matching entry in `stepCaptures[]` is used.
 */
router.post("/tests/:testId/baselines/:stepNumber/accept", requireRole("qa_lead"), (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "test not found" });
  const project = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "test not found" });

  const stepNumber = parseInt(req.params.stepNumber, 10);
  if (!Number.isFinite(stepNumber) || stepNumber < 0) {
    return res.status(400).json({ error: "invalid stepNumber" });
  }

  const runId = String(req.body?.runId || "");
  if (!runId) return res.status(400).json({ error: "runId is required" });

  const run = runRepo.getById(runId);
  if (!run || run.projectId !== project.id) {
    return res.status(404).json({ error: "run not found" });
  }

  const result = (run.results || []).find(r => r.testId === test.id);
  if (!result) return res.status(404).json({ error: "test result not found on run" });
  const browser = resolveBrowser(req.query?.browser || req.body?.browser || run.browser || "chromium").name;

  // Locate the source screenshot on disk. For step 0 we use the final
  // screenshot; for step N we use the matching stepCaptures entry.
  let relArtifactPath;
  if (stepNumber === 0) {
    relArtifactPath = result.screenshotPath;
  } else {
    const cap = (result.stepCaptures || []).find(c => c.step === stepNumber);
    relArtifactPath = cap?.screenshotPath;
  }
  if (!relArtifactPath) {
    return res.status(404).json({ error: "screenshot not captured for that step" });
  }

  // Strip any signing query params and map /artifacts/screenshots/foo.png →
  // <SHOTS_DIR>/foo.png. Reject anything that escapes the screenshots dir.
  const cleanPath = String(relArtifactPath).split("?")[0];
  const prefix = "/artifacts/screenshots/";
  if (!cleanPath.startsWith(prefix)) {
    return res.status(400).json({ error: "screenshot path is not under /artifacts/screenshots/" });
  }
  const fileName = cleanPath.slice(prefix.length);
  const sourceAbsPath = path.resolve(SHOTS_DIR, fileName);
  if (!sourceAbsPath.startsWith(path.resolve(SHOTS_DIR) + path.sep)) {
    return res.status(400).json({ error: "invalid screenshot path" });
  }
  if (!fs.existsSync(sourceAbsPath)) {
    return res.status(404).json({ error: "screenshot file missing on disk" });
  }

  try {
    const { baselinePath } = acceptBaseline({ testId: test.id, browser, stepNumber, sourceAbsPath });
    logActivity({ ...actor(req),
      type: "test.baseline_accept", projectId: project.id, projectName: project.name,
      detail: `Accepted visual baseline for ${test.id} [${browser}] step ${stepNumber}`, status: "success",
    });
    res.json({ ok: true, baselinePath, testId: test.id, browser, stepNumber });
  } catch (err) {
    // Log the real error server-side; return a generic message to the client
    // per AGENT.md ("5xx errors never leak internal details").
    console.error(formatLogLine("error", null, `[POST baselines/accept] ${test.id}#${stepNumber}: ${err.message}`));
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /api/v1/tests/:testId/baselines/:stepNumber
 * Delete a baseline. The next run will create a new baseline from its capture.
 */
router.delete("/tests/:testId/baselines/:stepNumber", requireRole("qa_lead"), (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "test not found" });
  const project = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "test not found" });

  const stepNumber = parseInt(req.params.stepNumber, 10);
  if (!Number.isFinite(stepNumber) || stepNumber < 0) {
    return res.status(400).json({ error: "invalid stepNumber" });
  }
  const browser = resolveBrowser(
    req.query?.browser || req.body?.browser || "chromium"
  ).name;

  // Remove the on-disk PNG too so the next run definitely rebuilds it.
  const absPath = path.join(BASELINES_DIR, test.id, browser, `step-${stepNumber}.png`);
  try { if (fs.existsSync(absPath)) fs.unlinkSync(absPath); } catch { /* ignore */ }

  const deleted = baselineRepo.deleteOne(test.id, stepNumber, browser);
  res.json({ ok: true, deleted, browser });
});

// ─── DIF-015: Interactive browser recorder ───────────────────────────────────
//
// Opens a Playwright browser at the project URL, streams the live CDP
// screencast to the RecorderModal (via SSE on the session ID), and captures
// raw user interactions. On stop, the captured actions are transformed into
// a Playwright test body and saved as a Draft test.

/**
 * POST /api/v1/projects/:id/record
 * Body: { startUrl?: string } — defaults to the project URL.
 *
 * Returns { sessionId } — the SSE run ID the frontend should subscribe to
 * for live screencast frames while recording.
 */
router.post("/projects/:id/record", requireRole("qa_lead"), expensiveOpLimiter, async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const startUrl = String(req.body?.startUrl || project.url || "").trim();
  if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    return res.status(400).json({ error: "startUrl must be a valid http(s) URL" });
  }

  const sessionId = `REC-${randomUUID().slice(0, 8)}`;
  try {
    // The frontend opens an SSE stream at /runs/:sessionId/events to receive
    // live screencast frames. That endpoint validates the runId against the
    // `runs` table — without a stub row here the SSE connection 404s and the
    // canvas stays black ("Waiting for browser stream…"). Create a minimal
    // running-row keyed by sessionId so SSE accepts it; stopRecording marks
    // it completed so orphan recovery doesn't flag it as interrupted.
    runRepo.create({
      id: sessionId,
      projectId: project.id,
      type: "record",
      status: "running",
      startedAt: new Date().toISOString(),
      workspaceId: project.workspaceId || null,
    });
    await startRecording({ sessionId, projectId: project.id, startUrl });
    logActivity({ ...actor(req),
      type: "test.record_start", projectId: project.id, projectName: project.name,
      detail: `Recorder started on ${startUrl}`, status: "running",
    });
    res.status(202).json({ sessionId, startUrl });
  } catch (err) {
    // Roll back the stub row so a failed launch doesn't leave an orphaned
    // "running" record that blocks future recordings or trips orphan recovery.
    try { runRepo.update(sessionId, { status: "failed", finishedAt: new Date().toISOString(), error: err.message }); } catch { /* row may not exist */ }
    console.error(formatLogLine("error", null, `[POST projects/${project.id}/record] startRecording failed: ${err.message}`));
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/stop
 * Body: { name: string } — the name to give the recorded Draft test.
 *
 * Persists the recorded actions as a new Draft test containing the
 * generated Playwright code. Returns the created test.
 */
router.post("/projects/:id/record/:sessionId/stop", requireRole("qa_lead"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const sess = getRecording(req.params.sessionId);
  // When the `MAX_RECORDING_MS` safety-net timeout has already torn the
  // session down, `getRecording` returns null but the generated test may
  // still be waiting in the short-lived completed-recordings cache. Fall
  // back to that cache so the user doesn't lose their captured actions to
  // a race with the auto-teardown.
  let autoCompleted = null;
  if (!sess) {
    autoCompleted = takeCompletedRecording(req.params.sessionId);
    if (!autoCompleted || autoCompleted.projectId !== project.id) {
      return res.status(404).json({ error: "recording session not found" });
    }
  } else if (sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }

  // `discard: true` tears down the browser without persisting a Draft test.
  // Used by the RecorderModal's Cancel/Discard button so abandoned recordings
  // do not leave junk tests in the DB.
  const discard = req.body?.discard === true;
  const name = String(req.body?.name || "").trim() || `Recorded flow @ ${new Date().toISOString()}`;

  let stopResult;
  let recoveredFromAutoTimeout = false;
  if (autoCompleted) {
    // Session was already torn down by the auto-timeout; regenerate the
    // Playwright body with the requested test name (the cached code was
    // generated with a default name).
    const playwrightCode = actionsToPlaywrightCode(name, autoCompleted.url, autoCompleted.actions);
    stopResult = { actions: autoCompleted.actions, playwrightCode, url: autoCompleted.url };
    recoveredFromAutoTimeout = true;
  } else {
    try {
      stopResult = await stopRecording(req.params.sessionId, { testName: name });
    } catch (err) {
      // Race window between the `getRecording()` guard above and
      // `stopRecording()` — the MAX_RECORDING_MS timeout may have fired in
      // the interim. Try the completed-recordings cache one more time.
      if (/not found/i.test(err.message || "")) {
        const cached = takeCompletedRecording(req.params.sessionId);
        if (cached && cached.projectId === project.id) {
          const playwrightCode = actionsToPlaywrightCode(name, cached.url, cached.actions);
          stopResult = { actions: cached.actions, playwrightCode, url: cached.url };
          recoveredFromAutoTimeout = true;
        }
      }
      if (!stopResult) {
        // Discard is a best-effort cleanup path: if the session is already
        // gone and we have nothing cached, the caller's intent (close the
        // browser, don't persist a test) is already satisfied.
        if (discard && /not found/i.test(err.message || "")) {
          logActivity({ ...actor(req),
            type: "test.record_discard", projectId: project.id, projectName: project.name,
            detail: `Recording discarded after session auto-teardown (${req.params.sessionId})`, status: "success",
          });
          return res.json({ ok: true, discarded: true, alreadyStopped: true });
        }
        console.error(formatLogLine("error", null, `[POST record/${req.params.sessionId}/stop] stopRecording failed: ${err.message}`));
        return res.status(500).json({ error: "Internal server error" });
      }
    }
  }

  // Close out the stub `runs` row created by POST /record so the SSE channel
  // releases its listener and orphan recovery doesn't pick this up later.
  try {
    runRepo.update(req.params.sessionId, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
  } catch { /* row may have been cleaned up already */ }

  if (discard) {
    logActivity({ ...actor(req),
      type: "test.record_discard", projectId: project.id, projectName: project.name,
      detail: `Recording discarded (${stopResult.actions?.length || 0} actions dropped)`, status: "success",
    });
    return res.json({ ok: true, discarded: true, ...(recoveredFromAutoTimeout ? { alreadyStopped: true } : {}) });
  }

  if (!stopResult.actions || stopResult.actions.length === 0) {
    return res.status(400).json({ error: "no actions were captured — nothing to save" });
  }

  const testId = generateTestId();
  const test = {
    id: testId,
    projectId: project.id,
    name,
    description: `Recorded from ${stopResult.url}`,
    steps: stopResult.actions.map((a, i) => `Step ${i + 1}: ${a.kind}${a.selector ? ` → ${a.selector}` : ""}${a.url ? ` → ${a.url}` : ""}`),
    playwrightCode: stopResult.playwrightCode,
    priority: "medium",
    type: "recorded",
    sourceUrl: stopResult.url,
    pageTitle: project.name,
    createdAt: new Date().toISOString(),
    lastResult: null,
    lastRunAt: null,
    qualityScore: null,
    isJourneyTest: false,
    reviewStatus: "draft",
    reviewedAt: null,
    promptVersion: null,
    modelUsed: null,
    linkedIssueKey: null,
    tags: ["recorded"],
    generatedFrom: "recorder",
    workspaceId: project.workspaceId || null,
  };
  testRepo.create(test);

  logActivity({ ...actor(req),
    type: "test.record_stop", projectId: project.id, projectName: project.name,
    testId, testName: name,
    detail: `Recorder captured ${stopResult.actions.length} actions → Draft test`, status: "success",
  });

  res.status(201).json({
    test,
    actionCount: stopResult.actions.length,
    ...(recoveredFromAutoTimeout ? { recoveredFromAutoTimeout: true } : {}),
  });
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/input
 *
 * Forwards a single input event (mouse click/move, keyboard, scroll) from
 * the browser-in-browser canvas in RecorderModal to the headless Playwright
 * page via CDP. This is what makes the recorder interactive — without this
 * route the canvas is a read-only screencast and the user can never produce
 * any recorded actions.
 *
 * Intentionally no rate-limiter here: input events arrive at ~60fps during
 * active use. The route is cheap (one async CDP send) and already gated
 * behind requireRole("qa_lead") + workspace scope.
 *
 * @route POST /api/v1/projects/:id/record/:sessionId/input
 * @auth requireRole("qa_lead")
 * @body {{ type: string, x?: number, y?: number, button?: number,
 *           clickCount?: number, key?: string, code?: string,
 *           text?: string, modifiers?: number,
 *           deltaX?: number, deltaY?: number }}
 * @returns {200} { ok: true }
 * @returns {400} { error: string } — missing/invalid event type
 * @returns {404} { error: string } — session not found
 */
router.post("/projects/:id/record/:sessionId/input", requireRole("qa_lead"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }

  const VALID_TYPES = new Set(["mousePressed", "mouseReleased", "mouseMoved", "keyDown", "keyUp", "char", "scroll"]);
  const { type } = req.body || {};
  if (!type || !VALID_TYPES.has(type)) {
    return res.status(400).json({ error: `Invalid event type. Must be one of: ${[...VALID_TYPES].join(", ")}` });
  }

  try {
    await forwardInput(req.params.sessionId, req.body);
    res.json({ ok: true });
  } catch (err) {
    // Session gone mid-flight (auto-timeout race) — treat as 404 not 500
    if (/not found/i.test(err.message || "")) {
      return res.status(404).json({ error: "recording session not found" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/v1/projects/:id/record/:sessionId
 * Inspect an in-flight recording (action count, status). Used by the modal
 * to poll for captured actions while the browser is still open.
 */
router.get("/projects/:id/record/:sessionId", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }
  res.json({
    sessionId: sess.id,
    status: sess.status,
    url: sess.url,
    startedAt: sess.startedAt,
    actionCount: sess.actions.length,
    actions: sess.actions.map(a => ({ kind: a.kind, selector: a.selector, value: a.value, key: a.key, url: a.url, ts: a.ts })),
  });
});

export default router;
