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

const router = Router();

// ─── Test CRUD ────────────────────────────────────────────────────────────────

router.get("/projects/:id/tests", (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const { page, pageSize, reviewStatus, category, search } = req.query;
  if (page !== undefined || pageSize !== undefined) {
    const filters = {};
    if (reviewStatus && reviewStatus !== "all") filters.reviewStatus = reviewStatus;
    if (category && category !== "all") filters.category = category;
    if (search) filters.search = search;
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
    generateInput: { name: cleanName, description: cleanDescription },
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

export default router;
