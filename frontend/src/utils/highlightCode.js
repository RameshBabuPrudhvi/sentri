/**
 * @module utils/highlightCode
 * @description Playwright/JS syntax highlighter for the code editor.
 * Tokenises the code first so strings/comments are never double-highlighted.
 * Returns an HTML string safe for dangerouslySetInnerHTML.
 */

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

  return tokens.map(t => {
    if (t.type === "comment") return `<span style="color:#546174;font-style:italic">${escHtml(t.text)}</span>`;
    if (t.type === "string")  return `<span style="color:#c3e88d">${escHtml(t.text)}</span>`;
    return highlightFragment(t.text);
  }).join("");
}
