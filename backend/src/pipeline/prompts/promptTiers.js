/**
 * @module pipeline/prompts/promptTiers
 * @description Tiered prompt system for local vs cloud AI models (MNT-009).
 *
 * Local models (Ollama / mistral:7b) have effective context windows of ~4K–8K
 * tokens. The full `SELF_HEALING_PROMPT_RULES` is ~4K tokens — when embedded
 * in the system prompt alongside persona rules, assertion rules, stability
 * rules, and the output schema, the total exceeds the model's capacity. The
 * model then produces hallucinated selectors, wrong function signatures,
 * missing `await`, and syntax errors — all caught by the validator.
 *
 * This module defines two tiers:
 *   - `cloud`  — full exhaustive rules (Anthropic, OpenAI, Google)
 *   - `local`  — compact core rules only (~200 tokens)
 *
 * ### Exports
 * - {@link getTier}           — Returns `"cloud"` or `"local"` based on the active provider.
 * - {@link TIER_CONFIG}       — Per-tier configuration (maxElements, fewShot, etc.).
 */

import { isLocalProvider } from "../../aiProvider.js";

/**
 * @typedef {Object} TierConfig
 * @property {string}  name          - Tier name (`"cloud"` or `"local"`).
 * @property {number}  maxElements   - Max DOM elements to include in prompts.
 * @property {boolean} includeFewShot - Whether to include few-shot examples.
 */

/** @type {Object<string, TierConfig>} */
export const TIER_CONFIG = {
  cloud: {
    name: "cloud",
    maxElements: 50,
    includeFewShot: true,
  },
  local: {
    name: "local",
    maxElements: 15,
    includeFewShot: false,
  },
};

/**
 * Determine the prompt tier based on the active AI provider.
 *
 * @returns {"cloud"|"local"} The tier name.
 */
export function getTier() {
  return isLocalProvider() ? "local" : "cloud";
}
