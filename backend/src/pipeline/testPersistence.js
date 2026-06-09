/**
 * testPersistence.js — Persist validated tests to SQLite
 *
 * Extracts the duplicated "Store in db" block that appeared in both
 * generateSingleTest and crawlAndGenerateTests.
 *
 * Exports:
 *   persistGeneratedTests(validatedTests, project, run, defaults) → testIds[]
 *   buildPipelineStats({ pagesFound, rawTests, removed, enhancedCount, rejected, journeys, dedupStats }) → object
 */

import { generateTestId } from "../utils/idGenerator.js";
import { getProviderName } from "../aiProvider.js";
import { PROMPT_VERSION } from "./prompts/outputSchema.js";
import * as testRepo from "../database/repositories/testRepo.js";
import { logActivity } from "../utils/activityLogger.js";
import { ACTIVITY_TYPES } from "../constants/activityTypes.js";
import { APPROVAL_SOURCE } from "../services/approvalService.js";
import { normalizeQualityToConfidence } from "./deduplicator.js";
// AUDIT-ROADMAP Bundle 6 (QAL-001) — opt-in dry-run gate. Imported lazily
// inside `persistGeneratedTests` so projects with `dryRunGate === false`
// (the default + every legacy project) pay zero startup cost for
// `browserPool` warm-up and `@playwright/test` resolution.
import { dryRunBatch } from "./dryRunGate.js";
// AUDIT-ROADMAP Bundle 6 (QAL-005) — second-pass LLM semantic review.
// Same lazy-eligibility model as the dry-run gate: the function is
// exported and the caller invokes it post-persist; default-off projects
// never pay an LLM call.
import { generateText, parseJSON } from "../aiProvider.js";
import { buildSemanticReviewPrompt, normalizeSemanticReviewResponse } from "./prompts/semanticReviewPrompt.js";
import { throwIfAborted } from "../utils/abortHelper.js";
import { formatLogLine } from "../utils/logFormatter.js";

/**
 * Pseudo-user attributed to machine-made approvals in `tests.approvedBy` and
 * `activities.userName`. The literal `"auto-approver"` is pinned by the
 * audit-trail contract in ROADMAP.md (AUTO-003b) and NEXT.md, so consumers
 * (UI badges, activity log filters, route handlers) should reference this
 * constant rather than re-typing the string.
 */
export const AUTO_APPROVER_USER = "auto-approver";

/**
 * Write validated test objects into SQLite and update the run record.
 *
 * @param {object[]} validatedTests — tests that passed validation
 * @param {object}   project        — project record (id, name, url)
 * @param {object}   run            — mutable run record
 * @param {object}   [defaults]     — fallback values for name/description/sourceUrl/pageTitle
 * @returns {string[]} array of created test IDs
 */
/**
 * Global kill-switch for auto-approval (AUTO-003b). Read on every persist
 * call from `DISABLE_AUTO_APPROVAL` — any truthy value (`"1"`, `"true"`,
 * `"yes"`, case-insensitive) forces every generated test to land in Draft
 * regardless of the project-level `autoApproveThreshold`.
 *
 * Intended for ops incidents: if an AI provider starts producing bad tests
 * faster than reviewers can revoke them, setting this env var is a
 * one-step rollback that doesn't require a code deploy or per-project
 * threshold reset. Per-project thresholds stay intact and take effect
 * again as soon as the env var is removed.
 *
 * The check runs per-call (one string compare and a `process.env` read,
 * neither measurable at the persist hot path) so operators don't have to
 * restart the backend to flip the switch — and so test fixtures can drive
 * the behaviour by mutating `process.env` between cases. Matches the
 * convention used by other env-var gates in the codebase (e.g.
 * `ALLOW_PRIVATE_URLS` in `routes/system.js`).
 *
 * Exported so the test suite can call it directly without round-tripping
 * through `persistGeneratedTests`.
 */
export function isAutoApprovalDisabled() {
  const v = String(process.env.DISABLE_AUTO_APPROVAL || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export async function persistGeneratedTests(validatedTests, project, run, defaults = {}) {
  const createdTestIds = [];
  // Global kill-switch (DISABLE_AUTO_APPROVAL) overrides every per-project
  // threshold — setting the env var pins `threshold = null`, which pins
  // `autoApproved = false` below, regardless of the project's configuration.
  // Read per-call (not cached at module scope) so operators can flip the
  // switch without restarting the backend.
  const threshold = isAutoApprovalDisabled()
    ? null
    : (Number.isFinite(project?.autoApproveThreshold) ? project.autoApproveThreshold : null);

  // AUDIT-ROADMAP Bundle 6 (QAL-001) — opt-in dry-run gate. When
  // `project.dryRunGate` is set, execute each validated test once via
  // `browserPool.acquire()` BEFORE persisting. Results merge onto the
  // test row alongside the existing fields below. Auto-approval is
  // additionally gated on `dryRunStatus === 'passed'` so a dry-run
  // failure is NEVER auto-approved (spec at
  // `docs/roadmap/AUDIT-ROADMAP.md:743-744`).
  //
  // The default is `dryRunGate = false`, in which case the result array
  // stays empty and the path below is byte-identical to pre-B6
  // (acceptance criterion at `docs/roadmap/AUDIT-ROADMAP.md:858-859`).
  let dryRunResults = [];
  if (project?.dryRunGate && validatedTests.length > 0) {
    try {
      // Forward `runId` + `testDataLocale` so the dry-run applies the SAME
      // B6 faker-substitution + setup/teardown transforms the real runner
      // does (`executeTest.js#applyB6PreExecutionTransforms`). Without this
      // the gate would execute raw `__FAKE_*__` tokens and false-fail every
      // token-using test. `run.id` seeds faker deterministically; the
      // persisted tests don't carry an id yet (assigned in the loop below),
      // so the dry-run faker seed uses the AI-set id or "dry-run" fallback.
      dryRunResults = await dryRunBatch(validatedTests, project, {
        signal: defaults.signal,
        runId: run?.id || null,
        testDataLocale: project.testDataLocale || "en",
      });
    } catch (err) {
      // Defensive: a gate failure must never block persistence. The
      // operator-facing signal is the structured warn line below; the
      // tests still ship to the review queue with `dryRunStatus = null`
      // so the gate visibly degrades rather than silently dropping
      // results.
      console.warn(formatLogLine("warn", run?.id || null, `[testPersistence] dry-run gate failed: ${err?.message || err}`));
      dryRunResults = [];
    }
  }

  for (let i = 0; i < validatedTests.length; i++) {
    const t = validatedTests[i];
    const dryRun = dryRunResults[i] || null;
    const testId = generateTestId();
    // `confidenceScore` is 0–1 (normalized by `deduplicateTests` and the
    // orchestrator's re-score step); `_quality` is 0–100. Normalize the
    // fallback so the `>= threshold` comparison below always compares on
    // the same scale — a bare `(t._quality || 0)` would read `75 >= 0.8`
    // as true and silently auto-approve every test if the fallback ever
    // activates. `threshold` is validated to (0, 1] on the route.
    const confidenceScore = Number.isFinite(t?.confidenceScore)
      ? t.confidenceScore
      : normalizeQualityToConfidence(t?._quality);
    // AUDIT-ROADMAP B6 (QAL-001) — auto-approval is gated on the dry-run
    // outcome WHEN the gate ran. Three states:
    //   • Gate disabled (default)     → `dryRun === null` → no extra gate;
    //                                    legacy threshold path applies.
    //   • Gate enabled, status passed → auto-approval eligible.
    //   • Gate enabled, status failed/trivial → auto-approval blocked
    //                                    regardless of confidence score.
    // Spec at `docs/roadmap/AUDIT-ROADMAP.md:743-744` is unambiguous:
    // "a dry-run failure is never auto-approved".
    const dryRunBlocksApproval = dryRun !== null && dryRun.status !== "passed";
    const autoApproved = threshold !== null
      && confidenceScore >= threshold
      && !dryRunBlocksApproval;
    // approvedAt is epoch ms (INTEGER per migration 017 + NEXT.md spec) so the
    // approvals timeline can do straight arithmetic ranges; reviewedAt stays
    // ISO-string to match the rest of the codebase's review timestamp convention.
    const now = new Date();
    const approvedAt = autoApproved ? now.getTime() : null;
    const reviewedAt = autoApproved ? now.toISOString() : null;
    const test = {
      // Spread AI-generated fields first so our critical fields below always win.
      // This prevents the AI from accidentally overriding id, projectId, reviewStatus, etc.
      ...t,
      id: testId,
      projectId: project.id,
      name: t.name || defaults.name || "",
      description: t.description || defaults.description || "",
      sourceUrl: t.sourceUrl || defaults.sourceUrl || project.url,
      pageTitle: t.pageTitle || defaults.pageTitle || project.name,
      createdAt: new Date().toISOString(),
      lastResult: null,
      lastRunAt: null,
      qualityScore: t._quality || 0,
      confidenceScore,
      // Per-factor breakdown that produced `qualityScore` — surfaced as the
      // "why was this drafted?" explainer in the Review Queue. `_qualityFactors`
      // is set by `deduplicateTests`; we coerce missing data to `[]` so the
      // column is never `undefined` (SQLite would store it as `null` then
      // `rowToTest` already round-trips `null` → `[]`, but being explicit here
      // means the test record matches what the API returns).
      qualityScoreFactors: Array.isArray(t._qualityFactors) ? t._qualityFactors : [],
      isJourneyTest: t.isJourneyTest || false,
      journeyType: t.journeyType || null,
      assertionEnhanced: t._assertionEnhanced || false,
      // All generated tests start as draft — humans must approve before regression
      reviewStatus: autoApproved ? "approved" : "draft",
      reviewedAt,
      approvalSource: autoApproved ? APPROVAL_SOURCE.AUTO : null,
      approvalThreshold: autoApproved ? threshold : null,
      approvedAt,
      approvedBy: autoApproved ? AUTO_APPROVER_USER : null,
      // Traceability — which prompt version and AI model produced this test
      promptVersion: PROMPT_VERSION,
      modelUsed: getProviderName(),
      // Requirement traceability — linked Jira/issue key (set via API or Import Issue)
      linkedIssueKey: t.linkedIssueKey || null,
      // Tags for filtering and traceability matrix grouping
      tags: Array.isArray(t.tags) ? t.tags : [],
      // API test marker — "api_har_capture" when generated from captured network traffic
      generatedFrom: t._generatedFrom || null,
      // ACL-001: Workspace scope — inherit from the project
      workspaceId: project.workspaceId || null,
      // AUDIT-ROADMAP B6 — quality-gate columns.
      // QAL-001 dry-run: NULL when the gate didn't run (legacy + opted-out
      // projects). 'passed' / 'failed' / 'trivial' otherwise — see
      // migration 073's docblock for the trivial-threshold semantics.
      dryRunStatus:     dryRun ? dryRun.status : null,
      dryRunError:      dryRun && dryRun.error ? dryRun.error : null,
      dryRunDurationMs: dryRun && Number.isFinite(dryRun.durationMs) ? dryRun.durationMs : null,
      // QAL-002 setup/teardown: persisted untouched from the LLM emission.
      // The runner (executeTest.js) handles the safe-execute contract;
      // we just round-trip the strings. Nullish collapses to NULL so the
      // column matches the migration's nullable shape.
      setupCode:    typeof t.setupCode === "string" && t.setupCode.length > 0 ? t.setupCode : null,
      teardownCode: typeof t.teardownCode === "string" && t.teardownCode.length > 0 ? t.teardownCode : null,
      // QAL-005 semantic review: populated by `feedbackLoop.js` AFTER
      // persistence (the loop reads the persisted test row by id, so
      // these columns are NULL at INSERT time and updated in place
      // once the second-pass LLM verdict lands). Pinned here so the
      // initial INSERT matches the column allowlist contract.
      semanticReviewScore:  null,
      semanticReviewIssues: [],
    };
    testRepo.create(test);
    if (autoApproved) {
      logActivity({
        type: ACTIVITY_TYPES.TEST_AUTO_APPROVE,
        projectId: project.id,
        projectName: project.name,
        testId,
        testName: test.name,
        detail: `Auto-approved at confidence ${confidenceScore.toFixed(2)} (threshold ${threshold.toFixed(2)})`,
        userName: AUTO_APPROVER_USER,
        workspaceId: project.workspaceId || null,
        // Structured provenance per ROADMAP.md / NEXT.md AUTO-003b spec —
        // detail is for humans; meta is for analytics joins (calibration UI).
        meta: { score: confidenceScore, threshold },
      });
    }
    run.tests.push(testId);
    createdTestIds.push(testId);
  }
  return createdTestIds;
}

/**
 * Build the pipelineStats summary object attached to run records.
 *
 * @param {object} params
 * @returns {object}
 */
/**
 * AUDIT-ROADMAP Bundle 6 (QAL-005) — apply the second-pass LLM semantic
 * reviewer to a batch of just-persisted tests.
 *
 * Three gates short-circuit the pass without an LLM call:
 *
 *   1. `project.semanticReview !== true` — opt-in feature; default off.
 *   2. `run.reviewerCollapsed === 1` — when the upstream B3 collapse gate
 *      fired, the same provider route serves both author and reviewer.
 *      A second pass on the same model has no independent signal, so we
 *      silently skip per the spec at
 *      `docs/roadmap/AUDIT-ROADMAP.md:852-853`.
 *   3. Empty `testIds` — nothing to review.
 *
 * Per surviving test, dispatch `generateText` with `agentRole: 'reviewer'`
 * (the existing AUTO-023 agent role; cost caps + spend gates apply
 * unchanged), parse the JSON verdict, and update the row's
 * `semanticReviewScore` + `semanticReviewIssues` columns.
 *
 * Verdicts:
 *   - `accept`  → row updated with score/issues; status untouched.
 *   - `revise`  → score + issues persist; the test stays in `draft`
 *                 (the route layer's existing review flow surfaces
 *                 the issues as chips on the queue card).
 *   - `reject`  → row's `reviewStatus` flips to `rejected` so the
 *                 test never executes.
 *
 * Best-effort throughout: any single test's LLM throw / parse error
 * leaves that row's columns NULL (treated identically to "the gate
 * was disabled"). The batch never aborts on a single failure — same
 * resilience contract as the dry-run gate.
 *
 * @param {string[]} testIds — IDs returned by `persistGeneratedTests`.
 * @param {Object} project
 * @param {Object} run
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ reviewed: number, rejected: number, skipped: string }>}
 */
export async function applySemanticReview(testIds, project, run, opts = {}) {
  if (!project?.semanticReview) return { reviewed: 0, rejected: 0, skipped: "disabled" };
  // run.reviewerCollapsed is INTEGER NOT NULL DEFAULT 0 — coerce both 1 and `true`.
  if (run?.reviewerCollapsed === 1 || run?.reviewerCollapsed === true) {
    return { reviewed: 0, rejected: 0, skipped: "reviewer_collapsed" };
  }
  if (!Array.isArray(testIds) || testIds.length === 0) {
    return { reviewed: 0, rejected: 0, skipped: "empty" };
  }

  let reviewed = 0;
  let rejected = 0;
  for (const id of testIds) {
    if (opts.signal?.aborted) break;
    let test;
    try { test = testRepo.getById(id); } catch { test = null; }
    if (!test) continue;
    try {
      throwIfAborted(opts.signal);
      // Pass the full `{ system, user }` envelope — `generateText`
      // forwards `system` as a separate high-priority message so the
      // QA-engineer persona + assertion-quality rules from
      // `buildSystemPrompt()` reach the reviewer. Passing only `user`
      // would silently drop the persona, degrading the four-question
      // semantic verdict that is the core of QAL-005.
      const prompt = buildSemanticReviewPrompt(test);
      const text = await generateText(prompt, {
        signal: opts.signal,
        agentRole: "reviewer",
        workspaceId: project.workspaceId || null,
        runId: run.id || null,
      });
      const parsed = parseJSON(text);
      const verdict = normalizeSemanticReviewResponse(parsed);
      const fields = {
        semanticReviewScore: verdict.score,
        semanticReviewIssues: verdict.issues,
      };
      // `reject` is the only verdict that mutates `reviewStatus`. `revise`
      // leaves the row in its prior state (typically `draft`) so the
      // existing review-queue chip surface picks up the issues.
      if (verdict.verdict === "reject") {
        fields.reviewStatus = "rejected";
        fields.reviewedAt = new Date().toISOString();
        // Clear the four AUTO-003b provenance columns. A test can be
        // auto-approved by `persistGeneratedTests` (dry-run gate off /
        // passed + above threshold) and THEN rejected here when the
        // semantic pass runs post-persist. Leaving `approvalSource:'auto'`
        // / `approvedBy:'auto-approver'` on a `rejected` row is the exact
        // "confusing audit-trail lie" the suite flags at
        // `backend/tests/auto-approval.test.js:147-152`; every other
        // rejection path (routes/tests.js, revoke) clears all four
        // alongside the status flip.
        fields.approvalSource = null;
        fields.approvalThreshold = null;
        fields.approvedAt = null;
        fields.approvedBy = null;
        rejected += 1;
      }
      testRepo.update(id, fields);
      reviewed += 1;
    } catch (err) {
      if (err?.name === "AbortError") break;
      // Single-test failure must never abort the batch. Operators get
      // the warn line; the row's `semanticReviewScore` stays NULL,
      // identical to "the gate was disabled" — defensible degrade.
      // eslint-disable-next-line no-console
      console.warn(formatLogLine("warn", run?.id || null, `[testPersistence] semantic review failed for ${id}: ${err?.message || err}`));
    }
  }
  return { reviewed, rejected, skipped: null };
}

export function buildPipelineStats({ pagesFound = 0, rawTests = [], removed = 0, enhancedCount = 0, rejected = 0, journeys = [], dedupStats = {}, apiEndpointsDiscovered = 0 }) {
  const apiTestCount = rawTests.filter(t => t._generatedFrom === "api_har_capture" || t._generatedFrom === "api_user_described").length;
  return {
    pagesFound,
    rawTestsGenerated: rawTests.length,
    duplicatesRemoved: removed,
    assertionsEnhanced: enhancedCount,
    validationRejected: rejected,
    journeysDetected: journeys.length,
    averageQuality: dedupStats.averageQuality || 0,
    apiEndpointsDiscovered,
    apiTestsGenerated: apiTestCount,
  };
}
