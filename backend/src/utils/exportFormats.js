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
      const bodyMatch = rawCode.match(/test(?:\.only|\.skip)?\s*\([^]*?async\s*\(\{\s*page\s*\}\)\s*=>\s*\{([^]*)\}\s*\)\s*;?\s*$/m);
      const testBody = bodyMatch ? bodyMatch[1].trimEnd() : (rawCode || "  // No Playwright code available for this test.");
      const indentedBody = testBody.split("\n").map(line => `  ${line}`).join("\n");
      const wrappedCode = `import { test, expect } from '@playwright/test';

test(${JSON.stringify(testCase?.name || `Test ${idx + 1}`)}, async ({ page }) => {
${indentedBody}
});
`;
      writeFileSync(path.join(testsDir, `${safeName}.spec.ts`), wrappedCode);
    });

    execFileSync("zip", ["-rq", outPath, "."], { cwd: projectRoot });
    return readFileSync(outPath);
  } finally {
    // Always clean up the temp directory, even if zip/readFile threw.
    // Without this, every failed export leaks a temp dir under the OS tmp folder.
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
