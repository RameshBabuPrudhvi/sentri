/**
 * testValidator.js — Rejects malformed or placeholder tests before they enter the DB
 *
 * Pure function — no external dependencies beyond the shared type enum.
 *
 * Exports:
 *   validateTest(test, projectUrl) → string[]  (empty = valid)
 */

import { VALID_TEST_TYPES } from "./prompts/outputSchema.js";

const VALID_TYPES_SET = new Set(VALID_TEST_TYPES);

/**
 * Validate a single AI-generated test object.
 * Returns an array of issue strings — empty means the test is valid.
 *
 * @param {object} test        — AI-generated test object
 * @param {string} projectUrl  — the project's base URL (for placeholder detection)
 * @returns {string[]}
 */
export function validateTest(test, projectUrl) {
  const issues = [];

  // Must have a meaningful name
  if (!test.name || test.name.trim().length < 5) {
    issues.push("name is missing or too short");
  }

  // Must have at least one step
  if (!Array.isArray(test.steps) || test.steps.length === 0) {
    issues.push("no test steps defined");
  }

  // Type must be a known industry-standard value (warn, don't reject — the AI
  // occasionally invents types like "user-flow" which are still usable tests)
  if (test.type) {
    const lower = test.type.toLowerCase();
    test.type = VALID_TYPES_SET.has(lower) ? lower : "functional";
  }

  // Scenario must be one of the expected values
  const validScenarios = new Set(["positive", "negative", "edge_case"]);
  if (test.scenario) {
    const lower = test.scenario.toLowerCase();
    test.scenario = validScenarios.has(lower) ? lower : "positive";
  }

  // Playwright code: if present, must be parseable (contain `async` and braces)
  if (test.playwrightCode) {
    if (!test.playwrightCode.includes("async")) {
      issues.push("playwrightCode missing async function");
    }
    if (!test.playwrightCode.includes("{")) {
      issues.push("playwrightCode missing function body");
    }
    // Reject placeholder URLs that the AI sometimes hallucinates
    if (test.playwrightCode.includes("https://example.com") ||
        test.playwrightCode.includes("http://example.com")) {
      issues.push("playwrightCode uses placeholder example.com URL");
    }
    // Must reference the actual project URL (or at least page.goto)
    if (!test.playwrightCode.includes("page.goto")) {
      issues.push("playwrightCode missing page.goto navigation");
    }
  }

  // Reject tests with duplicate/generic names the AI sometimes produces
  const genericNames = ["test 1", "test 2", "test 3", "untitled", "sample test", "example test"];
  if (test.name && genericNames.includes(test.name.toLowerCase().trim())) {
    issues.push("generic placeholder test name");
  }

  return issues;
}
