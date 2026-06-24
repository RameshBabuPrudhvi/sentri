/**
 * @module tests/test-fixture-management
 * @description B6 / QAL-002 — setup/teardown + project-level toggle round-trip.
 *
 * Pins three contracts via real SQLite + repo round-trips:
 *
 *   1. `projectRepo` round-trips the three new B6 toggle columns
 *      (`dryRunGate`, `semanticReview`, `testDataLocale`) without
 *      mutating the rest of the project surface.
 *   2. `testRepo` round-trips the four B6 test-row columns
 *      (`setupCode`, `teardownCode`, `dryRunStatus`, `dryRunError`,
 *      `dryRunDurationMs`, `semanticReviewScore`,
 *      `semanticReviewIssues`).
 *   3. `semanticReviewIssues` parses as JSON when the input is an array
 *      and round-trips through INSERT + getById.
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import { generateProjectId, generateTestId } from "../src/utils/idGenerator.js";

const t = createTestContext();
const { test, summary } = t.createTestRunner();

function seedProject(overrides = {}) {
  const id = generateProjectId();
  projectRepo.create({
    id,
    name: "B6 fixture project",
    url: "https://example.com",
    createdAt: new Date().toISOString(),
    workspaceId: "__system__",
    ...overrides,
  });
  return projectRepo.getById(id);
}

function seedTest(projectId, overrides = {}) {
  const id = generateTestId();
  testRepo.create({
    id,
    projectId,
    name: "B6 fixture test",
    description: "",
    playwrightCode: "// no-op",
    createdAt: new Date().toISOString(),
    reviewStatus: "draft",
    workspaceId: "__system__",
    ...overrides,
  });
  return testRepo.getById(id);
}

test("projectRepo defaults the three B6 toggles to safe-off", () => {
  t.resetDb();
  const project = seedProject();
  assert.equal(project.dryRunGate, false);
  assert.equal(project.semanticReview, false);
  assert.equal(project.testDataLocale, "en");
});

test("projectRepo.update round-trips dryRunGate boolean → INTEGER", () => {
  t.resetDb();
  const project = seedProject();
  projectRepo.update(project.id, { dryRunGate: true });
  const reloaded = projectRepo.getById(project.id);
  assert.equal(reloaded.dryRunGate, true);
  // Toggle back to confirm the false branch isn't sticky.
  projectRepo.update(project.id, { dryRunGate: false });
  assert.equal(projectRepo.getById(project.id).dryRunGate, false);
});

test("projectRepo.update round-trips semanticReview boolean → INTEGER", () => {
  t.resetDb();
  const project = seedProject();
  projectRepo.update(project.id, { semanticReview: true });
  assert.equal(projectRepo.getById(project.id).semanticReview, true);
});

test("projectRepo.update collapses null/empty testDataLocale to 'en'", () => {
  t.resetDb();
  const project = seedProject({ testDataLocale: "fr" });
  assert.equal(projectRepo.getById(project.id).testDataLocale, "fr");
  projectRepo.update(project.id, { testDataLocale: null });
  assert.equal(projectRepo.getById(project.id).testDataLocale, "en");
  projectRepo.update(project.id, { testDataLocale: "" });
  assert.equal(projectRepo.getById(project.id).testDataLocale, "en");
});

test("testRepo round-trips setupCode + teardownCode", () => {
  t.resetDb();
  const project = seedProject();
  const persisted = seedTest(project.id, {
    setupCode: "await page.evaluate(() => localStorage.clear());",
    teardownCode: "await page.evaluate(() => localStorage.clear());",
  });
  assert.equal(typeof persisted.setupCode, "string");
  assert.ok(persisted.setupCode.includes("localStorage.clear"));
  assert.ok(persisted.teardownCode.includes("localStorage.clear"));
});

test("testRepo defaults setupCode + teardownCode to null when omitted", () => {
  t.resetDb();
  const project = seedProject();
  const persisted = seedTest(project.id);
  assert.equal(persisted.setupCode, null);
  assert.equal(persisted.teardownCode, null);
});

test("testRepo round-trips dryRun columns + nulls when absent", () => {
  t.resetDb();
  const project = seedProject();
  const persisted = seedTest(project.id, {
    dryRunStatus: "failed",
    dryRunError: "locator timeout 5000ms exceeded",
    dryRunDurationMs: 1247,
  });
  assert.equal(persisted.dryRunStatus, "failed");
  assert.equal(persisted.dryRunError, "locator timeout 5000ms exceeded");
  assert.equal(persisted.dryRunDurationMs, 1247);

  const blank = seedTest(project.id);
  assert.equal(blank.dryRunStatus, null);
  assert.equal(blank.dryRunError, null);
  assert.equal(blank.dryRunDurationMs, null);
});

test("testRepo round-trips semanticReviewIssues as JSON array", () => {
  t.resetDb();
  const project = seedProject();
  const persisted = seedTest(project.id, {
    semanticReviewScore: 72,
    semanticReviewIssues: ["Trivial assertion on URL", "No state-change verification"],
  });
  assert.equal(persisted.semanticReviewScore, 72);
  assert.ok(Array.isArray(persisted.semanticReviewIssues));
  assert.equal(persisted.semanticReviewIssues.length, 2);
  assert.equal(persisted.semanticReviewIssues[0], "Trivial assertion on URL");
});

test("testRepo defaults semanticReviewIssues to [] when null", () => {
  t.resetDb();
  const project = seedProject();
  const persisted = seedTest(project.id);
  assert.deepEqual(persisted.semanticReviewIssues, []);
  assert.equal(persisted.semanticReviewScore, null);
});

test("testRepo.update can change dryRunStatus + semanticReviewScore independently", () => {
  t.resetDb();
  const project = seedProject();
  const persisted = seedTest(project.id);
  testRepo.update(persisted.id, { dryRunStatus: "passed", dryRunDurationMs: 850 });
  let reloaded = testRepo.getById(persisted.id);
  assert.equal(reloaded.dryRunStatus, "passed");
  assert.equal(reloaded.dryRunDurationMs, 850);
  // Updating semantic columns later doesn't blow away the dry-run cols.
  testRepo.update(persisted.id, { semanticReviewScore: 88, semanticReviewIssues: [] });
  reloaded = testRepo.getById(persisted.id);
  assert.equal(reloaded.dryRunStatus, "passed", "dryRunStatus survives subsequent updates");
  assert.equal(reloaded.semanticReviewScore, 88);
});

await summary("test-fixture-management");
