/**
 * Extract the first fenced JavaScript code block from a Markdown string.
 * Returns the trimmed code, or "" if no block is found.
 */
export default function extractCodeBlock(markdown) {
  const match = markdown.match(/```(?:javascript|js)?\n([\s\S]*?)```/i);
  return match?.[1]?.trim() || "";
}
