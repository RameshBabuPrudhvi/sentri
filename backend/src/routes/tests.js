/**
 * @module routes/tests
 * @description Test CRUD, AI generation, single-test run, fixtures, visual baselines. Mounted at `/api/v1` (INF-005).
 *
 * REFACTOR-NOTE: the interactive recorder (10 routes) was extracted to
 * `routes/recorder.js`, the export/traceability routes to
 * `routes/testExports.js`, and the review state-machine (approve / reject
 * / restore / revoke / bulk / approval-stats) to `routes/testApprovals.js`.
 * What remains here is test CRUD, AI generation, single-test run, fixture
 * uploads, and the visual-regression baseline endpoints.
 *
 * ### Endpoints
 * | Method   | Path                                             | Description                         |
 * |----------|--------------------------------------------------|-------------------------------------|
 * | `GET`    | `/api/v1/projects/:id/tests`                     | List tests for a project            |
 * | `GET`    | `/api/v1/tests`                                  | List all tests                      |
 * | `GET`    | `/api/v1/tests/counts`                           | Workspace review-queue tab counts   |
 * | `GET`    | `/api/v1/tests/:testId`                          | Get a single test                   |
 * | `PATCH`  | `/api/v1/tests/:testId`                          | Edit test (steps, name, code, etc.) |
 * | `GET`    | `/api/v1/tests/:testId/fixtures`                 | List CAP-001 data-driven fixtures   |
 * | `POST`   | `/api/v1/tests/:testId/fixtures`                 | Upload CAP-001 fixture rows         |
 * | `POST`   | `/api/v1/projects/:id/tests`                     | Create a manual test (Draft)        |
 * | `DELETE` | `/api/v1/projects/:id/tests/:testId`             | Delete a test                       |
 * | `POST`   | `/api/v1/projects/:id/tests/generate`            | AI-generate test(s) from description|
 * | `POST`   | `/api/v1/tests/:testId/run`                      | Run a single test                   |
 * | `GET`    | `/api/v1/projects/:id/tests/counts`              | Per-status test counts              |
 * | `GET`    | `/api/v1/tests/:testId/baselines`                | List visual-regression baselines    |
 * | `POST`   | `/api/v1/tests/:testId/baselines/:n/accept`      | Accept a captured screenshot        |
 * | `DELETE` | `/api/v1/tests/:testId/baselines/:n`             | Delete a baseline                   |
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
import { validateTestPayload, validateTestUpdate } from "../utils/validate.js";
import { isApiTest } from "../runner/codeParsing.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { aiGenerationLimiter, expensiveOpLimiter } from "../middleware/appSetup.js";
import { demoQuota } from "../middleware/demoQuota.js";
import { actor } from "../utils/actor.js";
import { requireRole } from "../middleware/requireRole.js";
import * as baselineRepo from "../database/repositories/baselineRepo.js";
import * as testFixtureRepo from "../database/repositories/testFixtureRepo.js";
import { acceptBaseline } from "../runner/visualDiff.js";
import { SHOTS_DIR, BASELINES_DIR, resolveBrowser } from "../runner/config.js";
import path from "path";
import fs from "fs";
import { resolveEnvOrThrow } from "../utils/routeHelpers.js";
import { envScopedProject } from "../utils/envScope.js"; // DIF-012 — shared helper, see module doc.
// §17 #1 / TD-012 — CSV parser + iteration-cap clamp extracted out of this
// 1,941-line god-object into `utils/csv.js`. The re-export under
// `__testables` below keeps `tests/fixture-iteration.test.js` working
// unchanged; new consumers should import directly from `utils/csv.js`.
import { parseCsvRows, clampIterationCap } from "../utils/csv.js";
import { findDependencyCycle } from "../runner/dependencyOrder.js";

const router = Router();

/**
 * Normalise a `tags` query-string value into a clean string[] suitable for
 * `filters.tags` on the testRepo paged/count helpers. Accepts either a
 * repeated query param (Express parses `?tags=a&tags=b` as an array) or a
 * single comma-joined string (`?tags=a,b`). Empty strings and whitespace-
 * only entries are dropped. Returns `undefined` when there's nothing to
 * filter on so callers can omit the key from the filters object entirely
 * (the repo treats a missing key and an empty array differently — empty
 * array would match nothing).
 */
const parseTags = (raw) => {
  if (!raw) return undefined;
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  const cleaned = arr.map((s) => String(s).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
};

function dependencyError(status, payload) {
  return { status, payload: { error: payload.message || payload.code, ...payload } };
}

function validateDependsOnForSave(projectId, testId, rawDependsOn) {
  if (rawDependsOn === undefined) return null;
  if (!Array.isArray(rawDependsOn)) {
    return dependencyError(400, { code: "INVALID_DEPENDS_ON", message: "dependsOn must be an array" });
  }
  const invalidIndex = rawDependsOn.findIndex((id) => typeof id !== "string" || !id.trim());
  if (invalidIndex !== -1) {
    return dependencyError(400, { code: "INVALID_DEPENDS_ON", index: invalidIndex, message: "dependsOn entries must be non-empty test ID strings" });
  }
  const dependsOn = [...new Set(rawDependsOn.map((id) => id.trim()))];
  const projectTests = testRepo.getByProjectId(projectId);
  const byId = new Map(projectTests.map((t) => [t.id, t]));

  if (dependsOn.includes(testId)) {
    return dependencyError(400, { code: "CYCLE_DETECTED", path: [testId, testId], message: "Dependency cycle detected" });
  }
  for (const depId of dependsOn) {
    if (!byId.has(depId)) {
      return dependencyError(400, { code: "MISSING_UPSTREAM", testId: depId, message: "dependsOn contains a test that does not exist in this project" });
    }
  }

  const graph = byId.has(testId)
    ? projectTests.map((t) => t.id === testId ? { ...t, dependsOn } : t)
    : [...projectTests, { id: testId, dependsOn }];
  const path = findDependencyCycle(graph);
  if (path) {
    return dependencyError(400, { code: "CYCLE_DETECTED", path, message: "Dependency cycle detected" });
  }
  return { dependsOn };
}

// ─── Test CRUD ────────────────────────────────────────────────────────────────

router.get("/projects/:id/tests", (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const { page, pageSize, reviewStatus, category, search, stale, tags } = req.query;
  if (page !== undefined || pageSize !== undefined) {
    const filters = {};
    if (reviewStatus && reviewStatus !== "all") filters.reviewStatus = reviewStatus;
    if (category && category !== "all") filters.category = category;
    if (search) filters.search = search;
    if (stale === "true") filters.stale = true;
    const parsedTags = parseTags(tags);
    if (parsedTags) filters.tags = parsedTags;
    return res.json(testRepo.getByProjectIdPaged(req.params.id, page, pageSize, filters));
  }
  res.json(testRepo.getByProjectId(req.params.id));
});

router.get("/tests", (req, res) => {
  // Scope to the user's workspace by fetching workspace project IDs (ACL-001)
  const wsProjects = projectRepo.getAll(req.workspaceId);
  const projectIds = wsProjects.map(p => p.id);

  const { page, pageSize, reviewStatus, category, search, stale, projectId, sortBy, tags } = req.query;
  if (page !== undefined || pageSize !== undefined) {
    const filters = {};
    if (reviewStatus && reviewStatus !== "all") filters.reviewStatus = reviewStatus;
    if (category && category !== "all") filters.category = category;
    if (search) filters.search = search;
    if (stale === "true") filters.stale = true;
    // `projectId` is honoured by the repo only if it falls inside the
    // workspace-scoped set, so a malicious client cannot use it to escape ACL.
    if (projectId && projectId !== "all") filters.projectId = projectId;
    // `sortBy` is whitelisted in the repo (SORT_BY_CLAUSES); unknown values
    // fall back to "newest" — we still pass it through unchanged so the
    // frontend's UI sort dropdown drives the SQL ORDER BY directly.
    if (sortBy) filters.sortBy = sortBy;
    const parsedTags = parseTags(tags);
    if (parsedTags) filters.tags = parsedTags;
    return res.json(testRepo.getAllPagedByProjectIds(projectIds, page, pageSize, filters));
  }
  res.json(testRepo.getAllByProjectIds(projectIds));
});

// GET /api/v1/tests/counts — workspace-wide review-queue tab counts.
//
// Powers the Review Queue's Draft/Approved/Rejected badges in a single
// round-trip. Previously the page fired three `pageSize: 1` paginated
// requests (one per status) on every filter / page change; this aggregate
// returns all three in one query.
//
// Accepts the same filter params as `GET /tests` minus `reviewStatus`
// (which is what we're partitioning) and `sortBy` (irrelevant for COUNT).
// `projectId` is ACL-narrowed inside the repo.
//
// Declared BEFORE `/tests/:testId` so the literal "counts" path doesn't
// get captured by the wildcard.
router.get("/tests/counts", (req, res) => {
  const wsProjects = projectRepo.getAll(req.workspaceId);
  const projectIds = wsProjects.map(p => p.id);

  const { category, search, stale, projectId, tags } = req.query;
  const filters = {};
  if (category && category !== "all") filters.category = category;
  if (search) filters.search = search;
  if (stale === "true") filters.stale = true;
  if (projectId && projectId !== "all") filters.projectId = projectId;
  const parsedTags = parseTags(tags);
  if (parsedTags) filters.tags = parsedTags;

  res.json(testRepo.countReviewQueueByProjectIds(projectIds, filters));
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

router.get("/tests/:testId/fixtures", (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "not found" });
  const project = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(testFixtureRepo.listFixtures(test.id));
});

router.post("/tests/:testId/fixtures", requireRole("qa_lead"), (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "not found" });
  const project = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const { format, rows, csvText, iterationCap } = req.body || {};
  // Format must be in the same allowlist as the migration's CHECK constraint
  // so a malformed write can't desync the persisted shape from the validator.
  if (format !== "csv" && format !== "json") {
    return res.status(400).json({ error: "format must be 'csv' or 'json'" });
  }
  // Cap resolution order: per-request override → per-project setting → default
  // 10. `clampIterationCap` enforces the [1, 100] hard ceiling regardless of
  // source so a malformed row in `projects.iterationCap` can't exhaust the
  // worker pool.
  const cap = clampIterationCap(iterationCap ?? project.iterationCap);
  let parsedRows = [];
  if (format === "json") parsedRows = Array.isArray(rows) ? rows : [];
  if (format === "csv") parsedRows = parseCsvRows(csvText);
  if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
    return res.status(400).json({ error: "fixture rows required" });
  }
  const clampedRows = parsedRows.slice(0, cap);
  // Keep fixture versions aligned with `test.codeVersion` so an AI fix that
  // bumps the test body invalidates stale fixtures (the runner reads the
  // fixture for the new version, finds nothing, and falls back to single
  // iteration — zero regression for fixture-less tests).
  const version = Number(test.codeVersion || 1);
  const fixture = testFixtureRepo.upsertFixture({ testId: test.id, version, format, rows: clampedRows });
  res.status(201).json({
    ...fixture,
    capApplied: cap,
    truncated: parsedRows.length > clampedRows.length,
  });
});

// Exported for backend/tests/fixture-iteration.test.js so the CSV parser and
// cap clamp can be exercised without spinning up an HTTP server.
export const __testables = { parseCsvRows, clampIterationCap };

router.patch("/tests/:testId", requireRole("qa_lead"), async (req, res) => {
  const validationErr = validateTestUpdate(req.body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "not found" });
  // Verify the test's project belongs to the user's workspace (ACL-001)
  const ownerProject = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!ownerProject) return res.status(404).json({ error: "not found" });

  const { steps, name, description, priority, regenerateCode, previewCode, playwrightCode, linkedIssueKey, tags, dependsOn } = req.body;

  const updates = {};

  if (typeof name === "string")        updates.name        = name.trim();
  if (typeof description === "string") updates.description = description.trim();
  if (typeof priority === "string")    updates.priority    = priority;
  if (typeof linkedIssueKey === "string") updates.linkedIssueKey = linkedIssueKey.trim() || null;
  if (Array.isArray(tags)) updates.tags = tags.map(t => String(t).trim()).filter(Boolean);
  const dependencyValidation = validateDependsOnForSave(test.projectId, test.id, dependsOn);
  if (dependencyValidation?.status) return res.status(dependencyValidation.status).json(dependencyValidation.payload);
  if (dependencyValidation) updates.dependsOn = dependencyValidation.dependsOn;
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

  const { name, description, steps, playwrightCode, priority, type, dependsOn } = req.body;

  const testId = generateTestId();
  const dependencyValidation = validateDependsOnForSave(project.id, testId, dependsOn);
  if (dependencyValidation?.status) return res.status(dependencyValidation.status).json(dependencyValidation.payload);
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
    // AUTO-014: legacy rows store `null` when no dependencies are declared
    // (`docs/api/tests.md` documents `null` for "tests with no dependency
    // declaration"). New tests created without a `dependsOn` body field
    // must match that contract — passing `undefined` here would let the
    // repo's `fillDefaults` coerce it to `[]`, drifting the persisted shape
    // for new vs. legacy rows.
    dependsOn: dependencyValidation?.dependsOn ?? null,
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

  // DIF-012: optional per-run environment override. Validated up-front so a
  // bad envId fails fast before any AI calls or audit-row creation. The
  // override flows into `generateFromUserDescription` via the scoped
  // project (matches runs.js + trigger.js — same contract everywhere).
  let environment;
  try {
    environment = resolveEnvOrThrow(req.body?.environmentId, project);
  } catch (err) {
    return res.status(err.httpStatus || 400).json({ error: err.message });
  }

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
    // DIF-012: persist on the run record so the audit trail records which
    // environment this generation targeted (consistent with crawl/run paths).
    environmentId: environment?.id || null,
  };
  runRepo.create(run);
  logActivity({ ...actor(req),
    type: "test.generate", projectId: project.id, projectName: project.name,
    detail: `Test generation pipeline started for "${cleanName}"`, status: "running",
  });

  res.status(202).json({ runId });

  runWithAbort(runId, run,
    // DIF-012: scope the project (url + credentials) to the selected env
    // for this generation run only — `project.url` is preserved as
    // `canonicalUrl` so the AUTO-015 baseline guard treats the run as
    // preview-style.
    (signal) => generateFromUserDescription(envScopedProject(project, environment), run, {
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
  // ENT-004 (migration 055): forward `runId` as a first-class arg on every
  // lifecycle activity so `/audit-log?runId=…` filters this single-test
  // run's events the same way it does for regression runs in routes/runs.js.
  // Without these, single-test runs would be invisible to the RunDetail
  // "View activity →" deep-link (runId column stays NULL → no match).
  logActivity({ ...actor(req),
    type: "test_run.start", projectId: project.id, projectName: project.name,
    runId,
    testId: test.id, testName: test.name,
    detail: `Single test run started — "${test.name}"`, status: "running",
  });

  runWithAbort(runId, run,
    (signal) => runTests(project, [test], run, { signal }),
    {
      onSuccess: () => logActivity({ ...actor(req),
        type: "test_run.complete", projectId: project.id, projectName: project.name,
        runId,
        testId: test.id, testName: test.name,
        detail: `Single test completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
      }),
      onFailActivity: (err) => ({
        type: "test_run.fail", projectId: project.id, projectName: project.name,
        runId,
        testId: test.id, testName: test.name,
        detail: `Test run failed for "${test.name}" — ${classifyError(err, "run").message}`,
      }),
      actorInfo: actor(req),
    },
  );

  res.json({ runId });
});

// ─── Test Review: Approve / Reject / Restore / Bulk ──────────────────────────
// All review state-machine routes (approve, reject, restore, revoke, bulk,
// approval-stats) MOVED to `backend/src/routes/testApprovals.js`. Mounted
// alongside this router in `backend/src/index.js`.

// ─── Test counts (lightweight — no row data, just per-status totals) ──────────

router.get("/projects/:id/tests/counts", (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const counts = testRepo.countByReviewStatus(req.params.id);
  res.json({ ...counts, total: counts.draft + counts.approved + counts.rejected });
});

// ─── Export endpoints ─────────────────────────────────────────────────────────
// Zephyr / TestRail / Playwright ZIP / traceability routes MOVED to
// `backend/src/routes/testExports.js`. Mounted alongside this router in
// `backend/src/index.js`.

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
router.post("/tests/:testId/baselines/:stepNumber/accept", requireRole("qa_lead"), async (req, res) => {
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
    const { baselinePath } = await acceptBaseline({ testId: test.id, browser, stepNumber, sourceAbsPath });
    logActivity({ ...actor(req),
      type: "test.baseline_accept", projectId: project.id, projectName: project.name,
      detail: `Accepted visual baseline for ${test.id} [${browser}] step ${stepNumber}`, status: "success",
    });
    res.json({ ok: true, baselinePath, testId: test.id, browser, stepNumber });
  } catch (err) {
    // Log the real error server-side; return a generic message to the client
    // per AGENTS.md ("5xx errors never leak internal details").
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
// All recorder routes MOVED to `backend/src/routes/recorder.js`.
// Mounted alongside this router in `backend/src/index.js`.

export default router;
