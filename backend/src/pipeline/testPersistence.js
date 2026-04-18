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

/**
 * Write validated test objects into SQLite and update the run record.
 *
 * @param {object[]} validatedTests — tests that passed validation
 * @param {object}   project        — project record (id, name, url)
 * @param {object}   run            — mutable run record
 * @param {object}   [defaults]     — fallback values for name/description/sourceUrl/pageTitle
 * @returns {string[]} array of created test IDs
 */
export function persistGeneratedTests(validatedTests, project, run, defaults = {}) {
  const createdTestIds = [];
  for (const t of validatedTests) {
    const testId = generateTestId();
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
      isJourneyTest: t.isJourneyTest || false,
      journeyType: t.journeyType || null,
      assertionEnhanced: t._assertionEnhanced || false,
      // All generated tests start as draft — humans must approve before regression
      reviewStatus: "draft",
      reviewedAt: null,
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
    };
    testRepo.create(test);
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
