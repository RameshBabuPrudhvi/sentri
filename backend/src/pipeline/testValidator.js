/**
 * testValidator.js — Rejects malformed or placeholder tests before they enter the DB
 *
 * Pure function — no external dependencies beyond the shared type enum.
 *
 * Exports:
 *   validateTest(test, projectUrl) → string[]  (empty = valid)
 */

import { VALID_TEST_TYPES } from "./prompts/outputSchema.js";
import { extractTestBody, stripPlaywrightImports } from "../runner/codeParsing.js";
import { parse } from "acorn";

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
    // Must reference navigation — page.goto for UI tests, or request.newContext / api.get/post for API tests
    const isApiTest = test._generatedFrom === "api_har_capture" || test._generatedFrom === "api_user_described"
      || test.playwrightCode.includes("request.newContext") || test.playwrightCode.includes("api.get") || test.playwrightCode.includes("api.post");
    if (!isApiTest && !test.playwrightCode.includes("page.goto")) {
      issues.push("playwrightCode missing page.goto navigation");
    }
    // Syntax validation — catch malformed code at generation time rather than
    // at run time. Uses acorn to parse the code as a proper AST, which catches
    // unbalanced braces, unterminated strings, and other syntax errors with
    // precise line:column positions. This is more reliable than new Function()
    // which couldn't handle `await` without an async wrapper.
    //
    // We strip imports first (they're removed at runtime by codeExecutor.js)
    // and wrap the extracted body in an async function so top-level `await`
    // is valid — matching the execution pattern in codeExecutor.js:45-67.
    try {
      const bodyForCheck = extractTestBody(test.playwrightCode);
      const codeToCheck = bodyForCheck
        ? stripPlaywrightImports(bodyForCheck)
        : stripPlaywrightImports(test.playwrightCode);
      // Wrap in async function so `await` is valid at the top level
      const wrapped = `(async () => {\n${codeToCheck}\n})();`;
      parse(wrapped, { ecmaVersion: 2022, sourceType: "script" });
    } catch (syntaxErr) {
      const loc = syntaxErr.loc ? ` (line ${syntaxErr.loc.line}, col ${syntaxErr.loc.column})` : "";
      issues.push(`playwrightCode has syntax error${loc}: ${syntaxErr.message}`);
    }
  }

  // Reject tests with duplicate/generic names the AI sometimes produces
  const genericNames = ["test 1", "test 2", "test 3", "untitled", "sample test", "example test"];
  if (test.name && genericNames.includes(test.name.toLowerCase().trim())) {
    issues.push("generic placeholder test name");
  }

  return issues;
}
