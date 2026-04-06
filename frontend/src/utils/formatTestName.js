/**
 * @module utils/formatTestName
 * @description Strips scenario prefixes from AI-generated test names.
 *
 * The AI often generates names like `"POSITIVE: User clicks a link…"` because
 * the prompt hints use that prefix format. Since the UI already renders scenario
 * tags as badges (✓ Positive, ✗ Negative, ⚡ Edge case), the prefix is redundant.
 *
 * @example
 * import { cleanTestName } from "../utils/formatTestName.js";
 * cleanTestName("POSITIVE: User logs in"); // → "User logs in"
 */

const SCENARIO_PREFIX_RE = /^\s*(POSITIVE|NEGATIVE|EDGE[\s_]*CASE|EDGE)\s*[:\-–—]\s*/i;

/**
 * Strip leading scenario prefixes (`POSITIVE:`, `NEGATIVE:`, `EDGE CASE:`)
 * from a test name. Returns the original string when no prefix is found.
 *
 * @param {string|null} name - The test name to clean.
 * @returns {string|null} Cleaned name, or the original value if no prefix found.
 */
export function cleanTestName(name) {
  if (!name || typeof name !== "string") return name;
  return name.replace(SCENARIO_PREFIX_RE, "");
}
