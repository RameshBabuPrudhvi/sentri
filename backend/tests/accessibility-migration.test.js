import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mapA11yViolations } from "../src/pipeline/crawlBrowser.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    failed += 1;
  }
}

console.log("\n♿ Accessibility migration");

const migrationPath = path.join(process.cwd(), "src/database/migrations/013_accessibility_violations.sql");
const sql = fs.readFileSync(migrationPath, "utf8");

test("creates accessibility_violations table", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS accessibility_violations/i);
});

test("includes required columns", () => {
  const expected = ["runId", "pageUrl", "ruleId", "impact", "wcagCriterion", "help", "description", "nodesJson", "createdAt"];
  for (const col of expected) {
    assert.match(sql, new RegExp(`\\b${col}\\b`));
  }
});

test("foreign key cascades on run delete", () => {
  assert.match(sql, /FOREIGN KEY \(runId\) REFERENCES runs\(id\) ON DELETE CASCADE/i);
});

test("indexes runId and (runId, pageUrl)", () => {
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_accessibility_violations_run\s+ON accessibility_violations\(runId\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_accessibility_violations_page\s+ON accessibility_violations\(runId, pageUrl\)/i);
});

console.log("\n♿ mapA11yViolations()");

test("returns [] for null / undefined / missing violations array (clean page sanity)", () => {
  assert.deepEqual(mapA11yViolations("RUN-1", "https://x.test/", null), []);
  assert.deepEqual(mapA11yViolations("RUN-1", "https://x.test/", undefined), []);
  assert.deepEqual(mapA11yViolations("RUN-1", "https://x.test/", {}), []);
  assert.deepEqual(mapA11yViolations("RUN-1", "https://x.test/", { violations: [] }), []);
});

test("normalises a single violation with all fields", () => {
  const axeResults = {
    violations: [
      {
        id: "color-contrast",
        impact: "serious",
        tags: ["cat.color", "wcag2aa", "wcag143"],
        help: "Elements must have sufficient color contrast",
        description: "Ensures the contrast between foreground and background colors meets WCAG 2 AA",
        nodes: [{ target: ["#btn"], html: "<button>Click</button>" }],
      },
    ],
  };
  const out = mapA11yViolations("RUN-1", "https://x.test/page", axeResults);
  assert.equal(out.length, 1);
  const [v] = out;
  assert.equal(v.runId, "RUN-1");
  assert.equal(v.pageUrl, "https://x.test/page");
  assert.equal(v.ruleId, "color-contrast");
  assert.equal(v.impact, "serious");
  assert.equal(v.wcagCriterion, "wcag143");
  assert.equal(v.help, "Elements must have sufficient color contrast");
  assert.match(v.description, /WCAG 2 AA/);
  // nodesJson must be parseable JSON containing the original nodes array
  const nodes = JSON.parse(v.nodesJson);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].target[0], "#btn");
});

test("falls back to safe defaults when fields are missing", () => {
  const axeResults = { violations: [{}] };
  const [v] = mapA11yViolations("RUN-2", "https://x.test/", axeResults);
  assert.equal(v.ruleId, "unknown");
  assert.equal(v.impact, null);
  assert.equal(v.wcagCriterion, null);
  assert.equal(v.help, "");
  assert.equal(v.description, "");
  assert.equal(v.nodesJson, "[]");
});

test("picks the first WCAG-shaped tag and ignores other tags", () => {
  const axeResults = {
    violations: [
      { id: "r1", tags: ["cat.aria", "best-practice"] },                    // no wcag tag → null
      { id: "r2", tags: ["wcag2a", "wcag111", "wcag2aa"] },                  // wcag111 first matching shape
      { id: "r3", tags: ["WCAG412"] },                                       // case-insensitive
    ],
  };
  const out = mapA11yViolations("RUN-3", "https://x.test/", axeResults);
  assert.equal(out[0].wcagCriterion, null);
  assert.equal(out[1].wcagCriterion, "wcag111");
  assert.equal(out[2].wcagCriterion, "WCAG412");
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
