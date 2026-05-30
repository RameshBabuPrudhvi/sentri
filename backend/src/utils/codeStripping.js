/**
 * @module utils/codeStripping
 * @description Bundle-A follow-up #F3 — shared helper for stripping
 * JavaScript string literals and comments before running substring /
 * regex code-presence checks.
 *
 * Pre-extract, `stripStringsAndComments` lived inside
 * `pipeline/assertionEnhancer.js` (added by Bundle-A fix #14). Bundle-A
 * fix #14 fixed `hasNoAssertions` / `hasStrongAssertions` /
 * `hasWeakAssertions` to ignore matches inside strings + comments, but
 * the SAME class of bug exists in `pipeline/deduplicator.js`'s
 * `QUALITY_FACTORS` rubric — `c.includes("getByRole")` matches even
 * when `getByRole` only appears in a `// TODO:` comment. Sharing the
 * helper means both consumers stay in lockstep and future call sites
 * have one obvious place to wire up.
 *
 * Strips:
 *   - `// line comments` through end-of-line
 *   - `/* block comments *⁠/` (single-line or multi-line)
 *   - `'single-quoted'`, `"double-quoted"`, ` ``template-literal`` `
 *     string contents (the literal delimiters are kept so subsequent
 *     parsing logic that cares about token boundaries still sees them).
 *
 * Backslash-escaped quotes inside string literals are honoured so a
 * string like `"he said \"hi\""` doesn't terminate early.
 *
 * Best-effort: not a full JavaScript tokeniser (template-literal
 * `${interpolations}` are stripped along with the rest of the string
 * body). Good enough for the assertion-presence + quality-rubric
 * heuristics — false positives are tests where a `${expect(real)}`
 * interpolation hides a real assertion, which is exotic enough to ignore.
 */

/**
 * Strip string literals and line/block comments from JS code so a
 * subsequent `.includes(...)` / `.test(...)` check sees only the
 * actual code.
 *
 * @param {string} code
 * @returns {string} Code with string contents + comments redacted.
 */
export function stripStringsAndComments(code) {
  if (!code) return "";
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    // Line comment `// …\n`
    if (ch === "/" && next === "/") {
      const eol = code.indexOf("\n", i + 2);
      if (eol < 0) { i = code.length; continue; }
      // Preserve the newline so line-anchored regexes still work.
      out += "\n";
      i = eol + 1;
      continue;
    }
    // Block comment `/* … */`
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    // String literals: keep the delimiters, drop the contents.
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === "\\" && i + 1 < code.length) {
          i += 2; // skip escaped char
          continue;
        }
        i += 1;
      }
      if (i < code.length) {
        out += quote;
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
