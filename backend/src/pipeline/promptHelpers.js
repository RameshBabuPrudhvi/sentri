/**
 * promptHelpers.js — Shared prompt utilities for test generation
 *
 * Pure functions used by all prompt builders:
 *   - resolveTestCountInstruction(testCount, local) → imperative AI instruction
 *   - withDials(base, dialsPrompt)                  → inject dials into prompt
 *
 * Supports both legacy string prompts and structured { system, user } messages.
 */

import { isLocalProvider } from "../aiProvider.js";
import { shouldLog, formatLogLine } from "../utils/logFormatter.js";

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

// ── Internal: inject dials into a plain string prompt ────────────────────────

function injectDialsIntoString(base, dialsPrompt) {
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
  // Fallback: append at end
  return `${base}\n\n${dialsPrompt}`;
}

/**
 * Inject an optional dialsPrompt into a base AI prompt.
 *
 * Accepts either:
 *   - A plain string (legacy) → injects before STRICT RULES / Requirements
 *   - A { system, user } object → appends dials to the end of the user message
 *
 * Returns the same shape as the input (string or { system, user }).
 *
 * Dials are injected into the USER message (not system) because they represent
 * per-request configuration that varies with each generation run.
 */
export function withDials(base, dialsPrompt) {
  if (!dialsPrompt) {
    if (shouldLog("debug")) {
      const len = typeof base === "string" ? base.length : (base.system?.length || 0) + (base.user?.length || 0);
      console.log(formatLogLine("debug", null, `[withDials] No dials prompt — using base prompt (${len} chars)`));
    }
    return base;
  }

  // ── Structured { system, user } messages ──────────────────────────────────
  if (typeof base === "object" && base.user) {
    const user = injectDialsIntoString(base.user, dialsPrompt);
    if (shouldLog("debug")) {
      console.log(formatLogLine("debug", null, `[withDials] Injected dials into structured user message (${user.length} chars)`));
    }
    return { system: base.system, user };
  }

  // ── Legacy plain string ───────────────────────────────────────────────────
  const final = injectDialsIntoString(base, dialsPrompt);
  if (shouldLog("debug")) {
    console.log(formatLogLine("debug", null, `[withDials] Injected dials into string prompt (${final.length} chars)`));
  }
  return final;
}
