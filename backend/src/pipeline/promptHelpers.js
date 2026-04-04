/**
 * promptHelpers.js — Shared prompt utilities for test generation
 *
 * Pure functions used by all prompt builders:
 *   - resolveTestCountInstruction(testCount, local) → imperative AI instruction
 *   - withDials(base, dialsPrompt)                  → inject dials before rules
 */

import { isLocalProvider } from "../aiProvider.js";

/**
 * Resolve the test count instruction for prompt builders.
 *
 * Maps the validated testCount dial value to an authoritative instruction
 * string that replaces the previously hardcoded "Generate 3-5 / 5-8 tests"
 * ranges.  The instruction is worded imperatively so the LLM treats it as a
 * hard constraint rather than a suggestion.
 *
 * @param {string} testCount — validated dial value (one|small|medium|large|ai_decides)
 * @param {boolean} [local]  — true when using a local provider (Ollama).
 *                              Defaults to isLocalProvider() when omitted.
 * @returns {string} e.g. "Generate EXACTLY 1 test" or "Generate 5-8 tests"
 */
export function resolveTestCountInstruction(testCount, local) {
  if (local === undefined) local = isLocalProvider();
  switch (testCount) {
    case "one":       return "Generate EXACTLY 1 test";
    case "small":     return "Generate EXACTLY 3-5 tests";
    case "medium":    return "Generate EXACTLY 6-10 tests";
    case "large":     return "Generate EXACTLY 10-20 tests";
    case "ai_decides":
    default:          return `Generate ${local ? "3-5" : "5-8"} tests`;
  }
}

/**
 * Inject an optional dialsPrompt into a base AI prompt, placing it
 * **before** the STRICT RULES / Requirements section so the LLM sees the
 * user's configuration (approach, test count, format, etc.) before the
 * hardcoded generation defaults.  LLMs prioritise earlier context, so
 * appending dials at the very end caused them to be ignored when they
 * conflicted with rules like "Generate 5-8 tests".
 *
 * Injection approach:
 *   1. Look for "STRICT RULES:" — used by buildIntentPrompt & buildUserRequestedPrompt
 *   2. Else look for "Requirements:" — used by buildJourneyPrompt
 *   3. Fallback: append at the end (safe default)
 */
export function withDials(base, dialsPrompt) {
  if (!dialsPrompt) return base;

  // Find the best injection point — before the rules section
  const markers = ["STRICT RULES:", "Requirements:"];
  for (const marker of markers) {
    const idx = base.indexOf(marker);
    if (idx !== -1) {
      return (
        base.slice(0, idx).trimEnd() +
        "\n\n" + dialsPrompt + "\n\n" +
        base.slice(idx)
      );
    }
  }

  // Fallback: append at end (shouldn't happen with current prompts)
  return `${base}\n\n${dialsPrompt}`;
}
