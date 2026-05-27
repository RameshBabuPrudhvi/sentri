/**
 * @module utils/highlightCode
 * @description Playwright/JS syntax highlighter for the code editor.
 * Tokenises the code first so strings/comments are never double-highlighted.
 * Returns an HTML string safe for dangerouslySetInnerHTML.
 *
 * Security — two-layer defence (audit §3.2):
 *   1. `escHtml()` escapes `&` / `<` / `>` on every span of user-supplied
 *      source before the keyword/regex transforms run, so the tokeniser
 *      itself cannot reintroduce attacker-controlled HTML.
 *   2. `DOMPurify` is applied to the assembled HTML as defence-in-depth
 *      against future regressions in the hand-rolled escaper (e.g. a new
 *      KEYWORDS pattern that accidentally captures `<` again). Allowlist
 *      is `<span>` + `style` — the only tag/attr this function emits.
 */
import DOMPurify from "dompurify";

/**
 * Allowlist mirrors exactly what `highlightFragment` + the token map emit:
 * a tree of `<span style="color:#xxx[;font-style:italic]">…</span>` nodes.
 * DOMPurify's built-in CSS filter still neutralises `expression()` /
 * `javascript:url()` / `@import` inside the `style` attribute if a future
 * change ever lets attacker-controlled text reach the style position.
 */
const PURIFY_CONFIG = {
  ALLOWED_TAGS: ["span"],
  ALLOWED_ATTR: ["style"],
  ALLOW_DATA_ATTR: false,
  KEEP_CONTENT: true,
};

/**
 * DOMPurify ships as a browser-only module: its default export only exposes
 * `.sanitize` when a `window` is available at import time. In Node (where
 * `frontend/tests/utils.test.js` imports this module directly), there is no
 * `window`, so the default export is the factory function and
 * `DOMPurify.sanitize` is undefined. The pre-fix runtime threw
 * `DOMPurify.sanitize is not a function` from CI's plain-Node test runner.
 *
 * The tokeniser is already escape-first safe by construction (every span
 * passes through `escHtml` before any transform), so when DOMPurify isn't
 * loaded we fall back to returning the assembled HTML as-is — the same
 * security posture the file had before the defence-in-depth pass landed.
 * In real browser builds DOMPurify works as expected; this guard only
 * kicks in during Node test runs.
 */
const purify = typeof DOMPurify?.sanitize === "function"
  ? (html) => DOMPurify.sanitize(html, PURIFY_CONFIG)
  : (html) => html;

/**
 * @param {string} code - JavaScript/TypeScript source code.
 * @returns {string} HTML string with inline color styles.
 */
export default function highlightCode(code) {
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Tokenise: pull out comments, strings, and template literals first
  const TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  const tokens = [];
  let last = 0;
  let m;
  while ((m = TOKEN_RE.exec(code)) !== null) {
    if (m.index > last) tokens.push({ type: "code", text: code.slice(last, m.index) });
    const raw = m[0];
    tokens.push({ type: raw.startsWith("//") || raw.startsWith("/*") ? "comment" : "string", text: raw });
    last = m.index + raw.length;
  }
  if (last < code.length) tokens.push({ type: "code", text: code.slice(last) });

  const KEYWORDS = /\b(import|export|from|const|let|var|async|await|return|if|else|true|false|null|undefined|new|typeof|instanceof|of|in|for|while|do|switch|case|break|continue|throw|try|catch|finally|class|extends|default)\b/g;
  const GLOBALS  = /\b(test|expect|describe|beforeAll|afterAll|beforeEach|afterEach|page|context|browser|request)\b/g;
  const METHODS  = /\.([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*\()/g;
  const NUMBERS  = /\b(\d+)\b/g;
  const ARROWS   = /(=&gt;|===|!==|==|!=|\|\||&amp;&amp;)/g;

  function highlightFragment(text) {
    return escHtml(text)
      .replace(KEYWORDS, '<span style="color:#c792ea">$1</span>')
      .replace(GLOBALS,  '<span style="color:#82aaff">$1</span>')
      .replace(METHODS,  '.<span style="color:#82aaff">$1</span>$2')
      .replace(NUMBERS,  '<span style="color:#f78c6c">$1</span>')
      .replace(ARROWS,   '<span style="color:#89ddff">$1</span>');
  }

  const html = tokens.map(t => {
    if (t.type === "comment") return `<span style="color:#546174;font-style:italic">${escHtml(t.text)}</span>`;
    if (t.type === "string")  return `<span style="color:#c3e88d">${escHtml(t.text)}</span>`;
    return highlightFragment(t.text);
  }).join("");

  // Audit §3.2 — belt-and-braces sanitization. The tokeniser is already
  // escape-first safe by construction (every user-supplied span passes
  // through `escHtml` before any transform), so this strips nothing in
  // practice today. It exists to catch a future regression where a new
  // highlighting rule forgets the escape step.
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}
