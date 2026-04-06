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
