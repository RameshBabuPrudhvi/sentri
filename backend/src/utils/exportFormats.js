/**
 * @module utils/exportFormats
 * @description Enterprise test export format builders.
 *
 * Converts test objects into industry-standard formats for import into
 * external test management and CI tools.
 *
 * ### Supported formats
 * | Format       | Use case                                          |
 * |--------------|---------------------------------------------------|
 * | Zephyr CSV   | Zephyr Scale / Zephyr Squad test management       |
 * | TestRail CSV | TestRail bulk import                              |
 *
 * ### Exports
 * - {@link buildZephyrCsv} — Generate Zephyr Scale CSV from test array.
 * - {@link buildTestRailCsv} — Generate TestRail CSV from test array.
 */

// ── Zephyr Scale CSV ─────────────────────────────────────────────────────────
// Zephyr Scale (formerly TM4J) CSV import format for Jira.
// See: https://support.smartbear.com/zephyr-scale-cloud/docs/test-management/import-export/

/**
 * buildZephyrCsv(tests) → string (CSV)
 *
 * Produces a CSV compatible with Zephyr Scale's "Import Test Cases from CSV"
 * feature. Columns match the standard Zephyr Scale import mapping.
 *
 * @param {object[]} tests — array of test objects
 * @returns {string} CSV content ready for Zephyr Scale import
 */
export function buildZephyrCsv(tests) {
  function esc(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }

  const headers = [
    "Name", "Objective", "Precondition", "Folder",
    "Status", "Priority", "Component", "Labels",
    "Test Script (Step-by-Step) - Step", "Test Script (Step-by-Step) - Test Data",
    "Test Script (Step-by-Step) - Expected Result",
    "Issue Links",
  ];

  const rows = [];
  for (const t of tests) {
    const steps = t.steps || [];
    const priorityMap = { high: "High", medium: "Normal", low: "Low" };
    const labels = [
      t.type || "functional",
      t.scenario || "positive",
      ...(t.tags || []),
      ...(t.isJourneyTest ? ["journey"] : []),
    ].join(" ");
    const folder = t.type
      ? `/${t.type.charAt(0).toUpperCase() + t.type.slice(1)}`
      : "/Functional";
    const status = t.reviewStatus === "approved" ? "Approved" : "Draft";

    if (steps.length === 0) {
      // Single row with no steps
      rows.push([
        esc(t.name),
        esc(t.description || ""),
        esc(t.preconditions || ""),
        esc(folder),
        esc(status),
        esc(priorityMap[t.priority] || "Normal"),
        esc(""),
        esc(labels),
        esc(""),
        esc(""),
        esc(""),
        esc(t.linkedIssueKey || ""),
      ].join(","));
    } else {
      // One row per step — Zephyr maps multiple rows with the same Name as one test case
      steps.forEach((step, idx) => {
        rows.push([
          esc(idx === 0 ? t.name : ""),
          esc(idx === 0 ? (t.description || "") : ""),
          esc(idx === 0 ? (t.preconditions || "") : ""),
          esc(idx === 0 ? folder : ""),
          esc(idx === 0 ? status : ""),
          esc(idx === 0 ? (priorityMap[t.priority] || "Normal") : ""),
          esc(""),
          esc(idx === 0 ? labels : ""),
          esc(step),
          esc(t.testData && idx === 0 ? JSON.stringify(t.testData) : ""),
          esc(idx === steps.length - 1 ? "Test completes successfully" : ""),
          esc(idx === 0 ? (t.linkedIssueKey || "") : ""),
        ].join(","));
      });
    }
  }

  return [headers.map(esc).join(","), ...rows].join("\n");
}

// ── TestRail CSV ─────────────────────────────────────────────────────────────
// TestRail bulk import expects a specific CSV format.
// See: https://www.gurock.com/testrail/docs/user-guide/howto/import-csv

/**
 * buildTestRailCsv(tests) → string (CSV)
 *
 * @param {object[]} tests
 * @returns {string} CSV content ready for TestRail import
 */
export function buildTestRailCsv(tests) {
  function esc(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }

  const headers = ["Title", "Section", "Type", "Priority", "Preconditions", "Steps", "Expected Result", "References"];
  const rows = tests.map(t => {
    const steps = (t.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n");
    const expectedResult = t.steps?.length > 0 ? t.steps[t.steps.length - 1] : "";
    return [
      esc(t.name),
      esc(t.type || "Functional"),
      esc(t.isJourneyTest ? "End-to-End" : "Functional"),
      esc(t.priority === "high" ? "Critical" : t.priority === "low" ? "Low" : "Medium"),
      esc(t.preconditions || ""),
      esc(steps),
      esc(expectedResult),
      esc(t.linkedIssueKey || ""),
    ].join(",");
  });

  return [headers.map(esc).join(","), ...rows].join("\n");
}

/**
 * @typedef {Object} PlaywrightExportProject
 * @property {string} name
 * @property {string} [url]
 */

/**
 * buildPlaywrightZip(project, tests) → Promise<Buffer> (ZIP)
 *
 * @param {PlaywrightExportProject} project
 * @param {object[]} tests
 * @returns {Promise<Buffer>}
 */
export async function buildPlaywrightZip(project, tests) {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");
  const path = await import("path");
  const { execFileSync } = await import("child_process");

  const tmpRoot = mkdtempSync(path.join(tmpdir(), "sentri-playwright-export-"));
  const projectRoot = path.join(tmpRoot, "project");
  const testsDir = path.join(projectRoot, "tests");
  const outPath = path.join(tmpRoot, "playwright-export.zip");
  mkdirSync(testsDir, { recursive: true });
  const baseUrl = project?.url || "http://localhost:3000";

  try {
    writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "sentri-playwright-export",
      private: true,
      version: "1.0.0",
      scripts: { test: "playwright test" },
      devDependencies: { "@playwright/test": "^1.58.2" },
    }, null, 2));

    writeFileSync(path.join(projectRoot, "playwright.config.ts"), `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: ${JSON.stringify(baseUrl)},
    trace: 'on-first-retry',
  },
});
`);

    writeFileSync(path.join(projectRoot, "README.md"), `# Playwright export from Sentri

## Run tests

\`\`\`bash
npm install
npx playwright test
\`\`\`
`);

    // Track filenames to disambiguate collisions when two tests normalize
    // to the same slug (e.g. "Login Test!" and "Login Test?"). Without this
    // the second writeFileSync silently overwrites the first.
    const usedNames = new Set();
    tests.forEach((testCase, idx) => {
      const baseSlug = String(testCase?.name || `test-${idx + 1}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `test-${idx + 1}`;
      let safeName = baseSlug;
      let suffix = 2;
      while (usedNames.has(safeName)) {
        safeName = `${baseSlug}-${suffix}`;
        suffix += 1;
      }
      usedNames.add(safeName);
      const rawCode = String(testCase?.playwrightCode || "").trim();
      // Accept any destructured fixture object that includes `page` — e.g.
      // `async ({ page })`, `async ({ page, context })`, `async ({ context, page, request })`.
      // The previous regex only matched the bare `{ page }` signature, which
      // caused any test recorded/generated with a broader fixture set to fall
      // through to the raw-source branch below, producing invalid nested
      // `test(...)` wrappers (and inlined `import` lines) in the output.
      const bodyMatch = rawCode.match(/test(?:\.only|\.skip)?\s*\([^]*?async\s*\(\s*\{[^}]*\bpage\b[^}]*\}\s*(?:,\s*[^)]*)?\)\s*=>\s*\{([^]*)\}\s*\)\s*;?\s*$/m);

      // Detect "already a complete Playwright test file" — both an `import …
      // from '@playwright/test'` line AND a `test(…)` call. If the extraction
      // regex couldn't pull a body but the raw code IS a full spec file (e.g.
      // unusual test wrapper syntax the regex doesn't handle: `async function`,
      // `test.describe` block, trailing comments after the closing paren), we
      // must NOT wrap it again — that produces an invalid .spec.ts with nested
      // `import` lines and a `test()` call inside another `test()`. Write the
      // raw source directly and let Playwright's own parser handle it.
      const hasPlaywrightImport = /import\s*\{[^}]*\b(?:test|expect)\b[^}]*\}\s*from\s*['"]@playwright\/test['"]/.test(rawCode);
      const hasTestCall = /\btest(?:\.only|\.skip|\.describe)?\s*\(/.test(rawCode);
      const isCompleteSpec = hasPlaywrightImport && hasTestCall;

      let fileContents;
      if (bodyMatch) {
        // Standard path: extract the body from a recognised `test(…, async ({ page, … }) => { … })`
        // wrapper and re-wrap with a canonical `{ page }` fixture. The canonical
        // wrapper is fine here because the body only references what it captured
        // from its own closure — `page` is always available, other fixtures
        // (context, request) pass through Playwright's test runner if referenced.
        const testBody = bodyMatch[1].trimEnd();
        const indentedBody = testBody.split("\n").map(line => `  ${line}`).join("\n");
        fileContents = `import { test, expect } from '@playwright/test';

test(${JSON.stringify(testCase?.name || `Test ${idx + 1}`)}, async ({ page }) => {
${indentedBody}
});
`;
      } else if (isCompleteSpec) {
        // Edge-case path: regex failed but rawCode is already a full spec file
        // (regex didn't recognise the wrapper shape — e.g. `async function`
        // expression, `test.describe` block, non-standard formatting). Ship
        // the file verbatim. Playwright's own parser is strictly more capable
        // than our regex; if the spec runs under `npx playwright test` in the
        // source project, it will run in the exported ZIP too.
        fileContents = rawCode.endsWith("\n") ? rawCode : `${rawCode}\n`;
      } else {
        // Raw-body path: rawCode is a naked body (no `import`, no `test()`
        // wrapper) or empty. Wrap it in the canonical shell so the exported
        // file is runnable.
        const testBody = rawCode || "  // No Playwright code available for this test.";
        const indentedBody = testBody.split("\n").map(line => `  ${line}`).join("\n");
        fileContents = `import { test, expect } from '@playwright/test';

test(${JSON.stringify(testCase?.name || `Test ${idx + 1}`)}, async ({ page }) => {
${indentedBody}
});
`;
      }
      writeFileSync(path.join(testsDir, `${safeName}.spec.ts`), fileContents);
    });

    try {
      execFileSync("zip", ["-rq", outPath, "."], { cwd: projectRoot });
    } catch (zipErr) {
      // Distinguish "zip binary not installed" from "zip ran but failed" so
      // the route handler can surface an actionable error. Without this,
      // both cases bubble up as opaque 500s and operators on minimal Docker
      // bases / Windows dev boxes have no way to know they're missing the
      // zip binary (documented in docs/api/tests.md but not self-evident).
      // ENOENT is what Node's execFileSync throws when the binary isn't on
      // $PATH. Every other failure is a genuine runtime error and keeps its
      // original message.
      if (zipErr.code === "ENOENT") {
        const err = new Error(
          "System `zip` binary not found on PATH. Install it (apt: `apt-get install zip`; alpine: `apk add zip`; macOS: included) or use a Docker image that ships it. See docs/api/tests.md § Standalone Playwright project ZIP for details."
        );
        err.code = "ZIP_BINARY_MISSING";
        throw err;
      }
      throw zipErr;
    }
    return readFileSync(outPath);
  } finally {
    // Always clean up the temp directory, even if zip/readFile threw.
    // Without this, every failed export leaks a temp dir under the OS tmp folder.
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
