/**
 * @module utils/errorClassifier
 * @description Shared error classification for user-facing messages.
 *
 * Converts raw Error objects from AI providers, Playwright, and network
 * failures into actionable, user-friendly messages. Used by:
 * - `routes/chat.js` — chat SSE error events
 * - `utils/runWithAbort.js` — run-level failure messages
 * - `testRunner.js` — browser launch / trace setup failures
 * - `crawler.js` — pipeline warning messages
 *
 * ### Design
 * A single `classifyError(err, context)` function handles all domains.
 * The optional `context` parameter (`"chat"` | `"run"` | `"crawl"`) lets
 * the classifier tailor fallback messages and context-window hints.
 *
 * ### Exports
 * - {@link classifyError} — Classify any error into a user-friendly string.
 * - {@link ERROR_CATEGORY} — Enum of error category IDs (for frontend styling).
 */

import { isRateLimitError } from "../aiProvider.js";

/**
 * Error category identifiers. Stored on `run.errorCategory` so the
 * frontend can render category-specific banners, icons, and action buttons.
 *
 * @enum {string}
 */
export const ERROR_CATEGORY = {
  TIMEOUT:          "timeout",
  RATE_LIMIT:       "rate_limit",
  AUTH:             "auth",
  OLLAMA_OFFLINE:   "ollama_offline",
  OLLAMA_MODEL:     "ollama_model",
  CONTEXT_LENGTH:   "context_length",
  PROVIDER_OVERLOAD: "provider_overload",
  BROWSER_LAUNCH:   "browser_launch",
  NAVIGATION:       "navigation",
  NO_PROVIDER:      "no_provider",
  UNKNOWN:          "unknown",
};

/**
 * Classify an error into a user-friendly message and category.
 *
 * @param {Error}  err                 - The raw error.
 * @param {"chat"|"run"|"crawl"} [context="run"] - Where the error occurred (tailors hints).
 * @returns {{ message: string, category: string }} User-facing message and category ID.
 */
export function classifyError(err, context = "run") {
  const msg = (err?.message || "").toLowerCase();
  const status = err?.status || err?.statusCode || 0;

  // ── Timeout ───────────────────────────────────────────────────────────
  if (err?.name === "TimeoutError" || msg.includes("timed out") || msg.includes("timeout")) {
    const hint = context === "chat"
      ? "try again or switch to a faster model in Settings."
      : "check that the target URL is accessible, or try a faster AI model.";
    return {
      message: `Request timed out — the operation took too long to respond. ${hint[0].toUpperCase()}${hint.slice(1)}`,
      category: ERROR_CATEGORY.TIMEOUT,
    };
  }

  // ── Rate limit / quota exhausted ──────────────────────────────────────
  if (isRateLimitError(err)) {
    return {
      message: "AI provider rate limit reached. Wait a few minutes or switch to a different provider in Settings.",
      category: ERROR_CATEGORY.RATE_LIMIT,
    };
  }

  // ── Authentication / invalid API key ──────────────────────────────────
  if (status === 401 || status === 403
    || msg.includes("invalid api key") || msg.includes("invalid x-api-key")
    || msg.includes("incorrect api key") || msg.includes("authentication")
    || msg.includes("unauthorized") || msg.includes("permission denied")
    || msg.includes("forbidden")) {
    return {
      message: "AI provider authentication failed — your API key may be invalid or expired. Check your key in Settings.",
      category: ERROR_CATEGORY.AUTH,
    };
  }

  // ── Ollama not running ────────────────────────────────────────────────
  if (msg.includes("econnrefused") || msg.includes("fetch failed") || msg.includes("cannot reach ollama")) {
    return {
      message: "Cannot connect to Ollama — make sure it's running (ollama serve) and the URL in Settings is correct.",
      category: ERROR_CATEGORY.OLLAMA_OFFLINE,
    };
  }

  // ── Ollama model not found ────────────────────────────────────────────
  if (msg.includes("model") && (msg.includes("not found") || msg.includes("pull"))) {
    return {
      message: "Ollama model not found. Run 'ollama pull <model>' or change the model in Settings.",
      category: ERROR_CATEGORY.OLLAMA_MODEL,
    };
  }

  // ── Context too long ──────────────────────────────────────────────────
  if (msg.includes("context length") || msg.includes("too many tokens") || msg.includes("maximum context")) {
    const hint = context === "chat"
      ? "Try a shorter message or clear the conversation."
      : "Try crawling fewer pages or reducing the test count.";
    return {
      message: `Content exceeds the AI model's context window. ${hint}`,
      category: ERROR_CATEGORY.CONTEXT_LENGTH,
    };
  }

  // ── Provider overloaded (Anthropic 529, etc.) ─────────────────────────
  if (msg.includes("overloaded") || status === 529 || status === 503) {
    return {
      message: "AI provider is temporarily overloaded. Wait a moment and try again.",
      category: ERROR_CATEGORY.PROVIDER_OVERLOAD,
    };
  }

  // ── No AI provider configured ─────────────────────────────────────────
  if (msg.includes("no ai provider configured")) {
    return {
      message: "No AI provider configured. Go to Settings to add an API key or enable Ollama.",
      category: ERROR_CATEGORY.NO_PROVIDER,
    };
  }

  // ── Browser launch failure (Playwright-specific) ──────────────────────
  if (msg.includes("browser") && (msg.includes("launch") || msg.includes("executable"))
    || msg.includes("chromium") || msg.includes("playwright")) {
    return {
      message: "Failed to start the browser. Ensure Chromium is installed and the PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH is correct.",
      category: ERROR_CATEGORY.BROWSER_LAUNCH,
    };
  }

  // ── Navigation failure ────────────────────────────────────────────────
  if (msg.includes("navigation") || msg.includes("net::err_") || msg.includes("page.goto")) {
    return {
      message: "Page navigation failed. Check that the project URL is accessible and responds correctly.",
      category: ERROR_CATEGORY.NAVIGATION,
    };
  }

  // ── Fallback ──────────────────────────────────────────────────────────
  const fallbackHint = context === "chat"
    ? "Please try again. If this persists, check your AI provider configuration in Settings."
    : "Check the run logs for details. If this persists, verify your AI provider and project URL in Settings.";
  return {
    message: `An unexpected error occurred. ${fallbackHint}`,
    category: ERROR_CATEGORY.UNKNOWN,
  };
}
