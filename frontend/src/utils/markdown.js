/**
 * @module utils/markdown
 * @description Lightweight markdown renderer shared by AIChat and ChatHistory.
 *
 * Security: escapes ALL text before applying markdown transforms so any HTML
 * in AI responses (e.g. <script>, <img onerror=…>) is neutralised before
 * reaching dangerouslySetInnerHTML. Code blocks are extracted first, escaped
 * separately, and restored via placeholders after the markdown pass.
 */

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderMarkdown(text) {
  // 1. Extract fenced code blocks → placeholders (already escaped)
  const codeBlocks = [];
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre data-lang="${lang || ""}"><code>${escapeHtml(code.trim())}</code></pre>`);
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
  return text;
}
