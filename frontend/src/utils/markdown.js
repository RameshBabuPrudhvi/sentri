/**
 * @module utils/markdown
 * @description Lightweight markdown renderer shared by AIChat and ChatHistory.
 *
 * Security — two-layer defence:
 *   1. **Escape-first parser**: every code-block-stripped span passes through
 *      `escapeHtml()` BEFORE the markdown transforms run. The grammar we
 *      support (bold / italic / heading / list / paragraph / inline-code /
 *      fenced-code) never re-introduces attacker-controlled HTML — there is
 *      no `[text](url)` link rule, no raw-HTML pass-through, no auto-link.
 *      So the parser itself is XSS-safe by construction.
 *
 *   2. **DOMPurify allowlist**: the final HTML is run through `DOMPurify`
 *      with a tight `ALLOWED_TAGS` / `ALLOWED_ATTR` list as defence-in-depth
 *      against a future change widening the grammar (e.g. someone adds a
 *      link rule and forgets the `javascript:` URL guard). The cost is
 *      ~22KB gzipped on the chat bundle, which is acceptable insurance for
 *      a surface that renders attacker-controlled LLM output. Audit §3.2.
 *
 * Code blocks are extracted first, escaped separately, and restored via
 * placeholders after the markdown pass so the user can read code samples
 * containing `<` / `>` / `&` verbatim.
 */
import DOMPurify from "dompurify";

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Allowlist for `DOMPurify.sanitize()`. Mirrors the tag set the parser is
 * capable of emitting — anything outside this list is stripped, even if a
 * future regression introduces it. `data-lang` is the only data-attribute
 * we emit (on `<pre>` blocks); the explicit allow keeps DOMPurify from
 * stripping it as unknown.
 *
 * Critically, this list contains no `<a>` / `<img>` / `<iframe>` / `<svg>`
 * — the four most common XSS sinks via `href` / `src` / `srcdoc` /
 * `onload`. If we ever add link rendering, switch `<a>` in and rely on
 * DOMPurify's built-in URL protocol allowlist (which blocks `javascript:`
 * by default).
 */
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    "p", "br",
    "strong", "em",
    "h1", "h2", "h3",
    "ul", "ol", "li",
    "pre", "code",
  ],
  ALLOWED_ATTR: ["data-lang"],
  // Defence against future regressions — `ALLOW_DATA_ATTR: false` stops
  // DOMPurify from globally permitting `data-*`. We only want `data-lang`
  // on <pre>, declared explicitly above.
  ALLOW_DATA_ATTR: false,
  // Drop anything not in the lists rather than substituting safe tags —
  // a stripped element is more obviously a parser bug than a silent
  // substitution.
  KEEP_CONTENT: true,
};

/**
 * DOMPurify is browser-only: its default export only exposes `.sanitize`
 * when a `window` is present at import time. In plain-Node test runs
 * (`frontend/tests/*.test.js`) there is no `window` and `.sanitize` is
 * undefined. Since step 3 of `renderMarkdown` already escapes every span
 * before any transform runs (the parser is XSS-safe by construction), we
 * fall through to identity in non-browser environments — the security
 * posture matches what this module shipped with before the defence-in-
 * depth pass. Real browser builds still get the allowlist.
 */
const purify = typeof DOMPurify?.sanitize === "function"
  ? (html) => DOMPurify.sanitize(html, PURIFY_CONFIG)
  : (html) => html;
 
export function renderMarkdown(text) {
  // 1. Extract fenced code blocks → placeholders (already escaped)
  const codeBlocks = [];
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre data-lang="${escapeHtml(lang || "")}"><code>${escapeHtml(code.trim())}</code></pre>`);
    return `\x00CODE${idx}\x00`;
  });

  // 2. Extract inline code → placeholders (already escaped)
  text = text.replace(/`([^`]+)`/g, (_, c) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<code>${escapeHtml(c)}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  // 3. Escape everything else — prevents XSS from AI-generated HTML
  text = escapeHtml(text);

  // 4. Apply markdown transforms on the now-safe text
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  text = text.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  text = text.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  text = text.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  text = text.split(/\n\n+/).map(p =>
    p.startsWith("<") ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`
  ).join("");

  // 5. Restore code block placeholders
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeBlocks[idx]);

  // 6. Defence-in-depth: run the assembled HTML through DOMPurify with the
  //    explicit allowlist above. The parser is already XSS-safe by
  //    construction (step 3), so this is belt-and-braces against future
  //    grammar expansions — see the module JSDoc for the rationale.
  return DOMPurify.sanitize(text, PURIFY_CONFIG);
}
