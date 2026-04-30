/**
 * Extract the first fenced JavaScript code block from a Markdown string.
 * Returns the trimmed code, or "" if no block is found.
 */
export default function extractCodeBlock(markdown) {
  // Allow optional trailing whitespace after the language tag — LLMs
  // frequently emit `` ```javascript \n `` with a stray space before the
  // newline, which would otherwise cause the match to fail and surface a
  // misleading "AI response did not include updated code" error.
  const match = markdown.match(/```(?:javascript|js)?[ \t]*\r?\n([\s\S]*?)```/i);
  return match?.[1]?.trim() || "";
}
