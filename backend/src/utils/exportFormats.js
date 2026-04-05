/**
 * exportFormats.js — Enterprise test export format builders
 *
 * Converts Sentri test objects into industry-standard formats for import
 * into external test management and CI tools.
 *
 * Supported formats:
 *   - JUnit XML     — CI integration (Jenkins, GitHub Actions, GitLab CI)
 *   - Xray JSON     — Jira Xray test management import
 *   - TestRail CSV  — TestRail bulk import format
 *
 * Each builder accepts an array of test objects (from db.tests) and returns
 * a string in the target format.
 */

// ── XML helpers ──────────────────────────────────────────────────────────────

function xmlEscape(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── JUnit XML ────────────────────────────────────────────────────────────────
// Standard format consumed by Jenkins, GitHub Actions, GitLab CI, CircleCI.
// One <testsuite> per project, one <testcase> per test.

/**
 * buildJUnitXml(tests, { suiteName, projectUrl }) → string
 *
 * @param {object[]} tests — array of Sentri test objects
 * @param {object} opts
 * @param {string} opts.suiteName — name for the <testsuite> element
 * @param {string} [opts.projectUrl] — URL attribute on the suite
 * @returns {string} well-formed JUnit XML
 */
export function buildJUnitXml(tests, { suiteName = "Sentri Tests", projectUrl = "" } = {}) {
  const passed = tests.filter(t => t.lastResult === "passed").length;
  const failed = tests.filter(t => t.lastResult === "failed").length;
  const total = tests.length;

  const testcases = tests.map(t => {
    const name = xmlEscape(t.name);
    const classname = xmlEscape(t.type || "functional");
    const time = "0"; // duration not available at export time

    let inner = "";
    if (t.lastResult === "failed") {
      inner = `\n      <failure message="${xmlEscape(t.lastError || "Test failed")}" type="AssertionError" />`;
    }

    // Steps as system-out for traceability
    const steps = (t.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n");
    if (steps) {
      inner += `\n      <system-out>${xmlEscape(steps)}</system-out>`;
    }

    return `    <testcase name="${name}" classname="${classname}" time="${time}">${inner}\n    </testcase>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${xmlEscape(suiteName)}" tests="${total}" failures="${failed}" errors="0" skipped="${total - passed - failed}" time="0" timestamp="${new Date().toISOString()}" hostname="sentri">
${testcases}
  </testsuite>
</testsuites>`;
}

// ── Xray JSON ────────────────────────────────────────────────────────────────
// Jira Xray test management import format.
// See: https://docs.getxray.app/display/XRAY/Import+Tests+-+REST

/**
 * buildXrayJson(tests, { projectKey }) → string (JSON)
 *
 * @param {object[]} tests
 * @param {object} opts
 * @param {string} opts.projectKey — Jira project key (e.g. "PROJ")
 * @returns {string} JSON string ready for Xray import API
 */
export function buildXrayJson(tests, { projectKey = "PROJ" } = {}) {
  const xrayTests = tests.map(t => {
    const steps = (t.steps || []).map((step, idx) => ({
      action: step,
      data: t.testData ? JSON.stringify(t.testData) : "",
      result: idx === (t.steps || []).length - 1 ? "Test passes" : "",
    }));

    return {
      testtype: "Manual",
      fields: {
        summary: t.name,
        description: t.description || "",
        priority: { name: t.priority === "high" ? "High" : t.priority === "low" ? "Low" : "Medium" },
        labels: [
          t.type || "functional",
          t.scenario || "positive",
          ...(t.tags || []),
          ...(t.isJourneyTest ? ["journey"] : []),
        ],
        ...(t.linkedIssueKey ? {
          issuelinks: [{
            type: { name: "Tests" },
            outwardIssue: { key: t.linkedIssueKey },
          }],
        } : {}),
      },
      ...(t.preconditions ? { precondition: t.preconditions } : {}),
      steps,
    };
  });

  return JSON.stringify(xrayTests, null, 2);
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
