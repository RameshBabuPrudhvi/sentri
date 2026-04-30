/**
 * @module tests/extractCodeBlock
 * @description Unit tests for the extractCodeBlock Markdown utility.
 * Runs with plain Node.js (no framework) — matches project test convention.
 *
 * Usage: node frontend/tests/extractCodeBlock.test.js
 */

import assert from "node:assert/strict";

// ── Helpers ──────────────────────────────────────────────────────────────────
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705  ${name}`);
  } catch (err) {
    console.log(`  \u274C  ${name}`);
    console.log(`      ${err.message}`);
    process.exitCode = 1;
  }
}

// ── Import ───────────────────────────────────────────────────────────────────
import extractCodeBlock from "../src/utils/extractCodeBlock.js";

// ═══════════════════════════════════════════════════════════════════════════════
// extractCodeBlock — language tag variants
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n\uD83E\uDDEA extractCodeBlock — language tag variants");

test("extracts code from a standard ```javascript block", () => {
  const md = "Some prose\n```javascript\nconst x = 1;\n```\nmore prose";
  assert.equal(extractCodeBlock(md), "const x = 1;");
});

test("extracts code from a ```js variant", () => {
  const md = "```js\nconst y = 2;\n```";
  assert.equal(extractCodeBlock(md), "const y = 2;");
});

test("handles missing language tag (bare ```)", () => {
  const md = "```\nconst z = 3;\n```";
  assert.equal(extractCodeBlock(md), "const z = 3;");
});

test("is case-insensitive on the language tag", () => {
  const md = "```JavaScript\nconst a = 4;\n```";
  assert.equal(extractCodeBlock(md), "const a = 4;");
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractCodeBlock — whitespace and line endings
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n\uD83E\uDDEA extractCodeBlock — whitespace and line endings");

test("handles trailing whitespace after the language tag", () => {
  const md = "```javascript   \nconst b = 5;\n```";
  assert.equal(extractCodeBlock(md), "const b = 5;");
});

test("handles trailing tabs after the language tag", () => {
  const md = "```js\t\nconst c = 6;\n```";
  assert.equal(extractCodeBlock(md), "const c = 6;");
});

test("handles CRLF line endings", () => {
  const md = "```javascript\r\nconst d = 7;\r\n```";
  assert.equal(extractCodeBlock(md), "const d = 7;");
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractCodeBlock — edge cases
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n\uD83E\uDDEA extractCodeBlock — edge cases");

test("returns empty string when no code block exists", () => {
  const md = "Just plain prose with no fenced block at all.";
  assert.equal(extractCodeBlock(md), "");
});

test("returns empty string for an empty code block", () => {
  const md = "```javascript\n```";
  assert.equal(extractCodeBlock(md), "");
});

test("returns only the first code block when multiple exist", () => {
  const md = [
    "```javascript",
    "const first = 1;",
    "```",
    "",
    "```javascript",
    "const second = 2;",
    "```",
  ].join("\n");
  assert.equal(extractCodeBlock(md), "const first = 1;");
});

test("trims surrounding whitespace from extracted code", () => {
  const md = "```javascript\n\n  const e = 8;  \n\n```";
  assert.equal(extractCodeBlock(md), "const e = 8;");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════
if (process.exitCode) {
  console.log("\n\u26A0\uFE0F  Some extractCodeBlock tests failed");
  process.exit(1);
}
console.log("\n\uD83C\uDF89 All extractCodeBlock tests passed");
