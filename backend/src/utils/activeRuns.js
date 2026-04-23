/**
 * @module utils/activeRuns
 * @description Single source of truth for querying active runs across both
 * execution paths (in-process `runAbortControllers` and BullMQ
 * `workerAbortControllers`).
 *
 * The chat endpoint uses `hasActiveRunForProvider("local")` to decide whether
 * Ollama is busy, avoiding direct coupling to the two registry shapes and
 * preventing the filter logic from drifting between callsites.
 *
 * ### Why this exists
 * Ollama is single-threaded — a concurrent chat request while a
 * crawl/generate/test run is making LLM calls will hang the model. We filter
 * by the provider each run captured at start time so cloud-provider runs
 * (Anthropic/OpenAI/Google) don't falsely block chat when the user has
 * switched to Ollama in Settings.
 *
 * ### Exports
 * - {@link captureProvider} — Snapshot the active provider for registry entries.
 * - {@link hasActiveRunForProvider} — Query whether any active run uses a given provider.
 */

import { getProvider } from "../aiProvider.js";
import { runAbortControllers } from "./runWithAbort.js";
import { workerAbortControllers } from "../workers/runWorker.js";

/**
 * Safely snapshot the active AI provider at run-start time. Returns `null`
 * when no provider is configured or `getProvider()` throws.
 *
 * Registry entries store the captured provider so downstream checks can
 * filter accurately even if the user switches providers mid-run.
 *
 * @returns {string|null} Provider ID (`"local"`, `"anthropic"`, etc.) or `null`.
 */
export function captureProvider() {
  try {
    return getProvider();
  } catch {
    return null;
  }
}

/**
 * True if any active run (in-process OR BullMQ) was started with the given
 * provider. Used by the chat endpoint to check whether Ollama is busy.
 *
 * @param {string} provider - Provider ID to match (e.g. `"local"`).
 * @returns {boolean}
 */
export function hasActiveRunForProvider(provider) {
  for (const entry of runAbortControllers.values()) {
    if (entry.provider === provider) return true;
  }
  for (const entry of workerAbortControllers.values()) {
    if (entry.provider === provider) return true;
  }
  return false;
}
