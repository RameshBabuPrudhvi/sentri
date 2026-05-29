/**
 * Bundle-A follow-up #F3 — unit coverage for the shared
 * `utils/codeStripping.js#stripStringsAndComments` helper. The helper
 * underpins:
 *   - `pipeline/assertionEnhancer.js` assertion-presence checks (fix #14)
 *   - `pipeline/deduplicator.js#scoreTestWithFactors` rubric (follow-up #F3)
 *
 * Both consumers now route through ONE implementation so the
 * comment/string-aware semantics can never drift.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { stripStringsAndComments } = await import("../src/utils/codeStripping.js");

test("strips // line comments to end of line", () => {
  const out = stripStringsAndComments("const x = 1; // comment here\nconst y = 2;");
  assert.ok(!out.includes("comment here"), "comment body must be stripped");
  assert.ok(out.includes("const y = 2;"), "code AFTER the comment must survive");
  assert.ok(out.includes("\n"), "newline preserved so line-anchored regexes still work");
});

test("strips /* block comments */ across multiple lines", () => {
  const out = stripStringsAndComments("a();\n/* block\n  comment\n  body */\nb();");
  assert.ok(!out.includes("block"), "block-comment body must be stripped");
  assert.ok(out.includes("a();"), "code before survives");
  assert.ok(out.includes("b();"), "code after survives");
});

test("strips single-quoted string contents but keeps delimiters", () => {
  const out = stripStringsAndComments("const s = 'expect(foo)';");
  assert.ok(!out.includes("expect(foo)"), "string body must be stripped");
  // Delimiters preserved so subsequent regexes see token boundaries.
  assert.ok(out.includes("''"), `delimiters preserved, got: ${out}`);
});

test("strips double-quoted string contents but keeps delimiters", () => {
  const out = stripStringsAndComments('const s = "toHaveURL fake";');
  assert.ok(!out.includes("toHaveURL"), "string body must be stripped");
  assert.ok(out.includes('""'), "delimiters preserved");
});

test("strips template-literal contents (incl. fake ${expect(...)} interpolations)", () => {
  const out = stripStringsAndComments("const s = `msg with expect(real) inside`;");
  assert.ok(!out.includes("expect(real)"), "template literal body must be stripped");
  assert.ok(out.includes("``"), "delimiters preserved");
});

test("honours backslash-escaped quotes inside strings", () => {
  // `"he said \"hi\""` should not terminate at the first inner `"`.
  const out = stripStringsAndComments('const s = "he said \\"hi\\""; const y = 1;');
  // The string body is stripped, but `const y = 1` AFTER the closing
  // outer quote must survive.
  assert.ok(out.includes("const y = 1;"), `code after escaped string must survive, got: ${out}`);
});

test("preserves real code identifiers (does NOT over-strip)", () => {
  // `expect(real)` outside of strings/comments must be preserved.
  const code = "await expect(page).toHaveURL('/dash');";
  const out = stripStringsAndComments(code);
  assert.ok(out.includes("expect("), "real expect() call must survive");
  assert.ok(out.includes("toHaveURL"), "real method name must survive");
  // String body inside `'/dash'` IS stripped — only delimiters remain.
  assert.ok(!out.includes("/dash"), "string body inside the call must be stripped");
});

test("handles unterminated strings defensively (doesn't throw)", () => {
  assert.doesNotThrow(() => stripStringsAndComments("const s = 'unterminated"));
});

test("handles unterminated block comments defensively (doesn't throw)", () => {
  assert.doesNotThrow(() => stripStringsAndComments("a();\n/* unterminated"));
});

test("empty / nullish inputs return empty string (no throw)", () => {
  assert.equal(stripStringsAndComments(""), "");
  assert.equal(stripStringsAndComments(null), "");
  assert.equal(stripStringsAndComments(undefined), "");
});

console.log("✅ code-stripping shared-util tests passed");
