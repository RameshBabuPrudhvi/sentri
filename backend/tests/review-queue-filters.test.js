/**
 * @module tests/review-queue-filters
 * @description Coverage for the filter branches added to
 * `getAllPagedByProjectIds` (cross-project) in PR #7:
 *
 *   - ACL-scoped `projectId` narrowing (the security boundary).
 *   - `category: "journey"` branch (orthogonal to api/ui).
 *   - `reviewStatus` + `category` combinations.
 *   - `meta.total` accuracy under filtering (regression for the
 *     "wrong totals" bug where client-side filtering produced
 *     mismatched pagination counts).
 *
 * The cross-project endpoint powers the Review Queue page; the filter
 * SQL was extended in PR #7. The sibling `getByProjectIdPaged` tests
 * live in `soft-delete.test.js` but don't exercise (a) cross-project
 * ACL boundary, (b) the journey branch, or (c) filter combinations.
 *
 * Run: node tests/review-queue-filters.test.js
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as testRepo from "../src/database/repositories/testRepo.js";

let projectCounter = 7000;
let testCounter    = 7000;

function makeProject(overrides = {}) {
  const id = "PRJ-RQF-" + (++projectCounter);
  return {
    id, name: "RQF Project " + id, url: "https://example.com",
    createdAt: new Date().toISOString(), status: "idle",
    ...overrides,
  };
}

function makeTest(projectId, overrides = {}) {
  const id = "TC-RQF-" + (++testCounter);
  return {
    id, projectId, name: "RQF Test " + id,
    description: "filter test", steps: [], tags: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    reviewStatus: "draft", priority: "medium", codeVersion: 0,
    isJourneyTest: false, assertionEnhanced: false,
    ...overrides,
  };
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM tests    WHERE id LIKE 'TC-RQF-%'");
  db.exec("DELETE FROM projects WHERE id LIKE 'PRJ-RQF-%'");
}

// Stage 2 (test-infra cleanup) — replaced the inline `function test(name, fn)`
// with the shared runner from `helpers/test-base.js`. See the comment in
// `secret-scanner.test.js` for the rationale + behavioural-compat notes.
import { createTestRunner } from "./helpers/test-base.js";
const { test, summary } = createTestRunner();

resetDb();

// Fixtures: two projects with a mix of review states and categories.
//   Project A: 1 draft UI, 1 draft journey, 1 draft API, 1 approved UI, 1 rejected UI.
//   Project B: 1 draft UI, 1 draft journey.
const projA = makeProject({ name: "Project A" });
const projB = makeProject({ name: "Project B" });
projectRepo.create(projA);
projectRepo.create(projB);

const tA_draft_ui      = makeTest(projA.id, { name: "A draft ui",      reviewStatus: "draft" });
const tA_draft_journey = makeTest(projA.id, { name: "A draft journey", reviewStatus: "draft", isJourneyTest: true });
const tA_draft_api     = makeTest(projA.id, { name: "A draft api",     reviewStatus: "draft", generatedFrom: "api_har_capture" });
const tA_approved_ui   = makeTest(projA.id, { name: "A approved ui",   reviewStatus: "approved" });
const tA_rejected_ui   = makeTest(projA.id, { name: "A rejected ui",   reviewStatus: "rejected" });
const tB_draft_ui      = makeTest(projB.id, { name: "B draft ui",      reviewStatus: "draft" });
const tB_draft_journey = makeTest(projB.id, { name: "B draft journey", reviewStatus: "draft", isJourneyTest: true });

for (const t of [
  tA_draft_ui, tA_draft_journey, tA_draft_api, tA_approved_ui, tA_rejected_ui,
  tB_draft_ui, tB_draft_journey,
]) testRepo.create(t);

const allIds = [projA.id, projB.id];

// ── Baseline ────────────────────────────────────────────────────────────────

console.log("\n🧪 getAllPagedByProjectIds — baseline");

test("returns every test across both projects when no filters supplied", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50);
  assert.equal(r.meta.total, 7, "total should match the 7 fixtures");
  assert.equal(r.data.length, 7);
});

test("empty projectIds short-circuits with zero results", () => {
  const r = testRepo.getAllPagedByProjectIds([], 1, 50);
  assert.equal(r.meta.total, 0);
  assert.equal(r.data.length, 0);
});

// ── reviewStatus filter ─────────────────────────────────────────────────────

console.log("\n🧪 getAllPagedByProjectIds — reviewStatus filter");

test("reviewStatus draft returns only draft tests", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { reviewStatus: "draft" });
  assert.equal(r.meta.total, 5, "5 drafts across both projects");
  for (const t of r.data) assert.equal(t.reviewStatus, "draft");
});

test("reviewStatus approved returns only approved tests", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { reviewStatus: "approved" });
  assert.equal(r.meta.total, 1);
  assert.equal(r.data[0].id, tA_approved_ui.id);
});

test("reviewStatus rejected returns only rejected tests", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { reviewStatus: "rejected" });
  assert.equal(r.meta.total, 1);
  assert.equal(r.data[0].id, tA_rejected_ui.id);
});

// ── category filter (api / ui / journey) ────────────────────────────────────

console.log("\n🧪 getAllPagedByProjectIds — category filter");

test("category api returns only api-marked tests", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { category: "api" });
  assert.equal(r.meta.total, 1);
  assert.equal(r.data[0].id, tA_draft_api.id);
});

test("category ui returns everything that is NOT api", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { category: "ui" });
  assert.equal(r.meta.total, 6, "all 7 minus the 1 api test");
  for (const t of r.data) assert.notEqual(t.generatedFrom, "api_har_capture");
});

test("category journey returns only isJourneyTest=1 rows (PR #7 — was previously client-side)", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { category: "journey" });
  assert.equal(r.meta.total, 2, "2 journey tests across both projects");
  const ids = new Set(r.data.map(t => t.id));
  assert.ok(ids.has(tA_draft_journey.id));
  assert.ok(ids.has(tB_draft_journey.id));
});

test("category journey: meta.total reflects filtered count (regression for the 'wrong totals' bug)", () => {
  // The bug pre-PR-#7: client filtered in-memory while meta.total reflected
  // the unfiltered server count. With server-side filtering, meta.total
  // matches data.length when the page can hold every match.
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { category: "journey" });
  assert.equal(r.meta.total, r.data.length, "meta.total must equal page size when all matches fit");
  assert.equal(r.meta.hasMore, false);
});

// ── Filter combinations ─────────────────────────────────────────────────────

console.log("\n🧪 getAllPagedByProjectIds — filter combinations");

test("reviewStatus=draft + category=journey returns only draft journey tests", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, {
    reviewStatus: "draft", category: "journey",
  });
  assert.equal(r.meta.total, 2);
  for (const t of r.data) {
    assert.equal(t.reviewStatus, "draft");
    assert.equal(t.isJourneyTest, true);
  }
});

test("reviewStatus=draft + category=api returns only draft api tests", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, {
    reviewStatus: "draft", category: "api",
  });
  assert.equal(r.meta.total, 1);
  assert.equal(r.data[0].id, tA_draft_api.id);
});

test("reviewStatus=approved + category=journey returns empty (no fixture matches)", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, {
    reviewStatus: "approved", category: "journey",
  });
  assert.equal(r.meta.total, 0);
  assert.equal(r.data.length, 0);
});

// ── ACL-scoped projectId narrowing (the security boundary) ──────────────────

console.log("\n🧪 getAllPagedByProjectIds — ACL projectId narrowing");

test("projectId filter narrows to a single project when it is in the workspace set", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { projectId: projA.id });
  assert.equal(r.meta.total, 5, "5 tests in project A");
  for (const t of r.data) assert.equal(t.projectId, projA.id);
});

test("projectId for an OUT-OF-SCOPE project is silently ignored (no scope widening)", () => {
  // Workspace contains only projA; client tries to inject projB. The ACL
  // is the `projectIds` array; the `projectId` filter can only narrow
  // within it. Result must NOT include projB's tests.
  const r = testRepo.getAllPagedByProjectIds([projA.id], 1, 50, { projectId: projB.id });
  assert.equal(r.meta.total, 5, "should fall back to projA's tests, not projB's");
  for (const t of r.data) {
    assert.equal(t.projectId, projA.id, "must not leak cross-workspace data");
  }
});

test("projectId filter combines with reviewStatus correctly", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, {
    projectId: projA.id, reviewStatus: "draft",
  });
  assert.equal(r.meta.total, 3, "3 drafts in project A");
  for (const t of r.data) {
    assert.equal(t.projectId, projA.id);
    assert.equal(t.reviewStatus, "draft");
  }
});

// ── search filter ───────────────────────────────────────────────────────────

console.log("\n🧪 getAllPagedByProjectIds — search filter");

test("search matches against test name (LIKE)", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { search: "journey" });
  assert.ok(r.meta.total >= 2, "should match the two journey-named tests");
  for (const t of r.data) assert.match(t.name, /journey/i);
});

test("search returns empty when no fixture matches", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { search: "nonexistent-substring-xyz" });
  assert.equal(r.meta.total, 0);
  assert.equal(r.data.length, 0);
});

// ── Pagination accuracy under filtering ─────────────────────────────────────

console.log("\n🧪 getAllPagedByProjectIds — pagination + filters");

test("filtered query paginates correctly: page 1 of 2 with pageSize=2", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 2, { reviewStatus: "draft" });
  assert.equal(r.meta.total, 5, "all 5 drafts counted");
  assert.equal(r.data.length, 2, "first page has 2 rows");
  assert.equal(r.meta.hasMore, true);
});

test("filtered query last page has the remainder", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 3, 2, { reviewStatus: "draft" });
  assert.equal(r.meta.total, 5);
  assert.equal(r.data.length, 1, "5 drafts ÷ 2 = 2 full pages + 1 remainder");
  assert.equal(r.meta.hasMore, false);
});

// ── Tag filter (PR #11 — escapes LIKE metacharacters) ──────────────────────

console.log("\n🧪 getAllPagedByProjectIds — tag filter");

// Add tag-tagged fixtures so we can isolate tag matches without colliding
// with the existing seven baseline rows. `_tag_` prefix so the assertions
// below can search by name to confirm the right rows came back.
const tA_tag_smoke    = makeTest(projA.id, { name: "_tag_ smoke",     tags: ["smoke"] });
const tA_tag_critical = makeTest(projA.id, { name: "_tag_ critical",  tags: ["critical", "p0"] });
const tA_tag_percent  = makeTest(projA.id, { name: "_tag_ percent",   tags: ["50%_off"] });
const tA_tag_quoted   = makeTest(projA.id, { name: "_tag_ quoted",    tags: ['needs "review"'] });
const tA_tag_under    = makeTest(projA.id, { name: "_tag_ under",     tags: ["a_b"] });
const tA_tag_plain_a  = makeTest(projA.id, { name: "_tag_ plain a",   tags: ["aXb"] });   // would match "a_b" without escape
const tA_tag_plain_b  = makeTest(projA.id, { name: "_tag_ plain b",   tags: ["50-off"] }); // would match "50%off" without escape

for (const t of [tA_tag_smoke, tA_tag_critical, tA_tag_percent, tA_tag_quoted, tA_tag_under, tA_tag_plain_a, tA_tag_plain_b]) {
  testRepo.create(t);
}

test("single tag filter matches rows tagged with that exact value", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { tags: ["smoke"] });
  // Only tA_tag_smoke carries the literal "smoke" tag.
  assert.equal(r.meta.total, 1);
  assert.equal(r.data[0].id, tA_tag_smoke.id);
});

test("multiple tags use OR semantics (any match wins)", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { tags: ["smoke", "critical"] });
  // Both tA_tag_smoke and tA_tag_critical should appear.
  const ids = new Set(r.data.map(t => t.id));
  assert.ok(ids.has(tA_tag_smoke.id),    "smoke tag row should be returned");
  assert.ok(ids.has(tA_tag_critical.id), "critical tag row should be returned");
  assert.equal(r.meta.total, 2);
});

test("empty tags array is treated as no filter (every row returned)", () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { tags: [] });
  // Same total as the unfiltered baseline + the 7 tag fixtures = 14.
  assert.equal(r.meta.total, 14);
});

test("`%` in a tag is escaped — does NOT match an unrelated literal value", () => {
  // Without escape, the LIKE pattern `%"50%off"%` would also match the row
  // whose tag is "50-off" (the `%` between "50" and "off" acts as a wildcard).
  // With escape, only the exact "50%_off" value matches.
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { tags: ["50%_off"] });
  assert.equal(r.meta.total, 1, "should only match the literal 50%_off tag");
  assert.equal(r.data[0].id, tA_tag_percent.id);
});

test("`_` in a tag is escaped — does NOT match an unrelated literal value", () => {
  // Without escape, `%"a_b"%` would match the row whose tag is "aXb"
  // (the `_` matches any single char). With escape, only "a_b" matches.
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { tags: ["a_b"] });
  assert.equal(r.meta.total, 1, "should only match the literal a_b tag");
  assert.equal(r.data[0].id, tA_tag_under.id);
});

test('embedded `"` in a tag value matches the JSON-escaped form', () => {
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, { tags: ['needs "review"'] });
  assert.equal(r.meta.total, 1);
  assert.equal(r.data[0].id, tA_tag_quoted.id);
});

test("tag filter combines with reviewStatus correctly", () => {
  // All tag fixtures are drafts by default, so this should match the same
  // single row as the "smoke" filter alone — proving the AND between tags
  // and reviewStatus, not just the tag clause in isolation.
  const r = testRepo.getAllPagedByProjectIds(allIds, 1, 50, {
    tags: ["smoke"], reviewStatus: "draft",
  });
  assert.equal(r.meta.total, 1);
  assert.equal(r.data[0].id, tA_tag_smoke.id);
});

test("countReviewQueueByProjectIds applies the tag filter (tab counts stay in sync)", () => {
  const counts = testRepo.countReviewQueueByProjectIds(allIds, { tags: ["smoke", "critical"] });
  // Both fixtures are drafts → draft=2, total=2.
  assert.equal(counts.draft, 2);
  assert.equal(counts.total, 2);
});

test("getByProjectIdPaged also applies the escaped tag filter", () => {
  const r = testRepo.getByProjectIdPaged(projA.id, 1, 50, { tags: ["50%_off"] });
  assert.equal(r.meta.total, 1, "single-project tag filter must escape % too");
  assert.equal(r.data[0].id, tA_tag_percent.id);
});

summary("review-queue-filters");
