/**
 * @module tests/utils
 * @description Unit tests for backend utility helpers.
 */

import assert from "node:assert/strict";
import {
  sanitise,
  validateUrl,
  validateProjectPayload,
  validateTestPayload,
  validateTestUpdate,
  validateBulkAction,
} from "../src/utils/validate.js";
import {
  generateTestId,
  generateRunId,
  generateProjectId,
  generateActivityId,
  initCountersFromExistingData,
} from "../src/utils/idGenerator.js";
import { throwIfAborted, isRunAborted, finalizeRunIfNotAborted } from "../src/utils/abortHelper.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log("\n🧪 validate utils");

test("sanitise trims and truncates", () => {
  assert.equal(sanitise("  hello  ", 3), "hel");
  assert.equal(sanitise(123), "");
});

test("validateUrl accepts http/https and rejects invalid protocols", () => {
  assert.equal(validateUrl("https://example.com"), null);
  assert.equal(validateUrl("http://example.com"), null);
  assert.match(validateUrl("ftp://example.com"), /http or https/i);
});

test("validateProjectPayload validates credentials fields", () => {
  const ok = validateProjectPayload({
    name: "My app",
    url: "https://example.com",
    credentials: { usernameSelector: "#u", passwordSelector: "#p", submitSelector: "#s" },
  });
  assert.equal(ok, null);

  const bad = validateProjectPayload({
    name: "My app",
    url: "https://example.com",
    credentials: { usernameSelector: 42 },
  });
  assert.match(bad, /usernameSelector/);
});

test("validateTestPayload enforces steps and priority", () => {
  assert.equal(validateTestPayload({ name: "T1", steps: ["one"], priority: "high" }), null);
  assert.match(validateTestPayload({ name: "T1", steps: "not-array" }), /Steps must be an array/);
  assert.match(validateTestPayload({ name: "T1", steps: ["ok"], priority: "urgent" }), /Priority/);
});

test("validateTestUpdate validates optional fields", () => {
  assert.equal(validateTestUpdate({ name: "Updated", tags: ["smoke"] }), null);
  assert.match(validateTestUpdate({ name: "  " }), /non-empty/);
  assert.match(validateTestUpdate({ tags: "smoke" }), /Tags must be an array/);
});

test("validateBulkAction validates ids and action", () => {
  assert.equal(validateBulkAction({ testIds: ["TC-1"], action: "approve" }), null);
  assert.match(validateBulkAction({ testIds: [], action: "approve" }), /non-empty array/);
  assert.match(validateBulkAction({ testIds: ["TC-1"], action: "archive" }), /Action must be/);
});

console.log("\n🧪 idGenerator utils");

test("generates sequential IDs for all domains", () => {
  const db = {};
  assert.equal(generateTestId(db), "TC-1");
  assert.equal(generateTestId(db), "TC-2");
  assert.equal(generateRunId(db), "RUN-1");
  assert.equal(generateProjectId(db), "PRJ-1");
  assert.equal(generateActivityId(db), "ACT-1");
});

test("initCountersFromExistingData seeds counters from persisted IDs", () => {
  const db = {
    tests: { "TC-4": {}, "TC-12": {} },
    runs: { "RUN-3": {} },
    projects: { "PRJ-9": {} },
    activities: { "ACT-2": {} },
  };
  initCountersFromExistingData(db);
  assert.equal(generateTestId(db), "TC-13");
  assert.equal(generateRunId(db), "RUN-4");
  assert.equal(generateProjectId(db), "PRJ-10");
  assert.equal(generateActivityId(db), "ACT-3");
});

console.log("\n🧪 abortHelper utils");

test("throwIfAborted throws AbortError when signal is aborted", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => throwIfAborted(controller.signal), /Aborted/);
});

test("isRunAborted checks run status and signal", () => {
  const activeRun = { status: "running" };
  const abortedRun = { status: "aborted" };
  const controller = new AbortController();

  assert.equal(isRunAborted(activeRun, controller.signal), false);
  assert.equal(isRunAborted(abortedRun, controller.signal), true);

  controller.abort();
  assert.equal(isRunAborted(activeRun, controller.signal), true);
});

test("finalizeRunIfNotAborted updates status and runs callback", () => {
  let completed = 0;
  const run = { status: "running" };
  finalizeRunIfNotAborted(run, () => { completed += 1; });
  assert.equal(run.status, "completed");
  assert.equal(completed, 1);

  const aborted = { status: "aborted" };
  finalizeRunIfNotAborted(aborted, () => { completed += 1; });
  assert.equal(aborted.status, "aborted");
  assert.equal(completed, 1);
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  Backend utility tests failed");
  process.exit(1);
}

console.log("\n🎉 Backend utility tests passed");
