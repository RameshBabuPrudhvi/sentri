/**
 * testValidator.js — Rejects malformed or placeholder tests before they enter the DB
 *
 * Pure function — no external dependencies beyond the shared type enum.
 *
 * Exports:
 *   validateTest(test, projectUrl) → string[]  (empty = valid)
 */

import { VALID_TEST_TYPES } from "./prompts/outputSchema.js";
import { extractTestBody, stripPlaywrightImports, patchNetworkIdle, repairBrokenStringLiterals } from "../runner/codeParsing.js";
import { parse } from "acorn";

const VALID_TYPES_SET = new Set(VALID_TEST_TYPES);

// ── Undeclared-variable heuristic for self-healing helper calls ─────────────
//
// AI sometimes hallucinates bare identifiers as arguments to the self-healing
// helpers instead of string literals, e.g.:
//   await safeFill(page, emailField, 'test@example.com')   ← emailField is never declared
//   await safeClick(page, submitButton)                     ← submitButton is never declared
//
// These pass syntax checking (they're valid JS) but always fail at runtime
// because the variables are never declared — the self-healing guards see
// `undefined` and throw. This heuristic catches them at generation time.

// Matches: safeClick(page, ident), safeFill(page, ident, ...), etc.
// Captures the bare identifier in group 1. Skips calls where the second
// argument starts with a quote (string literal) or backtick (template).
const HELPER_BARE_IDENT_RE =
  /\b(?:safeClick|safeFill|safeDblClick|safeHover|safeExpect)\s*\(\s*(?:page|expect)\s*,\s*(?:(?:page|expect)\s*,\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/g;

// Identifiers that are available at runtime (injected by codeExecutor.js
// sandbox, self-healing helpers, or declared inside the wrapper). This list
// must stay in sync with codeExecutor.js:buildSandboxContext() and
// getSelfHealingHelperCode(). Only identifiers that could plausibly appear
// as the label/text argument need to be listed — not every sandbox global.
const RUNTIME_GLOBALS = new Set([
  // Sandbox-provided (codeExecutor.js:46-131)
  "page", "context", "expect", "console", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "Promise", "Error", "TypeError",
  "RangeError", "SyntaxError", "ReferenceError", "URIError",
  "AggregateError", "DOMException", "JSON", "Date", "Math", "RegExp",
  "Array", "Object", "String", "Number", "Boolean", "Symbol", "Map", "Set",
  "WeakMap", "WeakSet", "ArrayBuffer", "SharedArrayBuffer", "DataView",
  "BigInt", "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
  "Buffer", "isNaN", "isFinite", "parseInt", "parseFloat",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "undefined", "NaN", "Infinity", "null", "true", "false",
  "atob", "btoa", "structuredClone",
  // Self-healing helpers (selfHealing.js:getSelfHealingHelperCode)
  "safeClick", "safeFill", "safeDblClick", "safeHover", "safeExpect",
  "findElement", "ensureReady", "retry", "sleep",
  "looksLikeSelector", "onlyFillable", "firstVisible",
  "DEFAULT_TIMEOUT", "RETRY_COUNT", "RETRY_DELAY", "FILLABLE_SELECTOR",
  "__healingHints", "__healingEvents",
  // Stubs declared in the wrapper (codeExecutor.js:182-185)
  "run", "browser", "request", "__testError",
]);

// Matches const/let/var declarations — captures the declared identifier name(s).
// Handles simple declarations and basic destructuring:
//   const foo = ...        → "foo"
//   let { bar, baz } = ... → "bar", "baz"
//   var [x, y] = ...       → "x", "y"
const DECLARATION_RE = /\b(?:const|let|var)\s+(?:\{([^}]+)\}|\[([^\]]+)\]|([A-Za-z_$][A-Za-z0-9_$]*))/g;

/**
 * Scan code for self-healing helper calls whose label/text argument is a bare
 * identifier that was never declared with const/let/var.
 *
 * @param {string} code — The cleaned test body (after import stripping, etc.)
 * @returns {string[]}    Array of issue strings (empty = no problems found).
 */
function detectUndeclaredHelperArgs(code) {
  // 1. Collect all locally declared identifiers
  const declared = new Set();
  let m;
  while ((m = DECLARATION_RE.exec(code)) !== null) {
    // Destructured object: { a, b: c, d } → a, c, d
    if (m[1]) {
      for (const part of m[1].split(",")) {
        // Handle renaming: `original: alias` → alias is the declared name
        const renamed = part.split(":").pop().trim();
        if (renamed) declared.add(renamed);
      }
    }
    // Destructured array: [x, y] → x, y
    else if (m[2]) {
      for (const part of m[2].split(",")) {
        const name = part.trim();
        if (name && /^[A-Za-z_$]/.test(name)) declared.add(name);
      }
    }
    // Simple: const foo
    else if (m[3]) {
      declared.add(m[3]);
    }
  }

  // Reset lastIndex since DECLARATION_RE has the global flag
  DECLARATION_RE.lastIndex = 0;

  // Also pick up function declarations: function foo(...)
  const fnDeclRe = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  while ((m = fnDeclRe.exec(code)) !== null) {
    declared.add(m[1]);
  }

  // 2. Find bare identifiers passed to self-healing helpers
  const issues = [];
  while ((m = HELPER_BARE_IDENT_RE.exec(code)) !== null) {
    const ident = m[1];
    if (RUNTIME_GLOBALS.has(ident)) continue;
    if (declared.has(ident)) continue;
    issues.push(
      `playwrightCode passes undeclared variable '${ident}' to helper — expected a string literal`
    );
  }
  // Reset lastIndex since the regex has the global flag
  HELPER_BARE_IDENT_RE.lastIndex = 0;

  return issues;
}

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
      const stripped = bodyForCheck
        ? stripPlaywrightImports(bodyForCheck)
        : stripPlaywrightImports(test.playwrightCode);
      // Apply the same repair passes used at runtime (codeExecutor.js:37-41)
      // so that known AI output patterns (e.g. newlines inside quoted strings,
      // networkidle usage) don't cause false-positive rejections.
      const codeToCheck = repairBrokenStringLiterals(patchNetworkIdle(stripped));
      // Wrap in async function so `await` is valid at the top level
      const wrapped = `(async () => {\n${codeToCheck}\n})();`;
      parse(wrapped, { ecmaVersion: 2022, sourceType: "script" });

      // ── Undeclared variable heuristic ───────────────────────────────────
      // Catches bare identifiers passed to self-healing helpers that were
      // never declared — a common AI hallucination pattern that produces
      // tests which are syntactically valid but always fail at runtime.
      const undeclaredIssues = detectUndeclaredHelperArgs(codeToCheck);
      for (const msg of undeclaredIssues) {
        issues.push(msg);
      }
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
