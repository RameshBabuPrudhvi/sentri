/**
 * formatTestName.js — Utility to strip scenario prefixes from AI-generated test names.
 *
 * The AI often generates names like "POSITIVE: User clicks a link…" because the
 * prompt hints use that prefix format.  Since the UI already renders scenario
 * tags as badges (✓ Positive, ✗ Negative, ⚡ Edge case), the prefix in the
 * title is redundant.
 *
 * Moved from utils/testName.js → utils/formatTestName.js for clarity.
 *
 * Usage:
 *   import { cleanTestName } from "../utils/formatTestName.js";
 *   <div>{cleanTestName(t.name)}</div>
 */

const SCENARIO_PREFIX_RE = /^\s*(POSITIVE|NEGATIVE|EDGE[\s_]*CASE|EDGE)\s*[:\-–—]\s*/i;

/**
 * Strip leading scenario prefixes (POSITIVE:, NEGATIVE:, EDGE:, EDGE CASE:)
 * from a test name.  Returns the original string when no prefix is found.
 */
export function cleanTestName(name) {
  if (!name || typeof name !== "string") return name;
  return name.replace(SCENARIO_PREFIX_RE, "");
}
