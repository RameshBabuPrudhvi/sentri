import { formatLogLine } from "../utils/logFormatter.js";

export const MAX_RETRIES = parseInt(process.env.LLM_MAX_RETRIES, 10) || 3;
export const BASE_DELAY_MS = parseInt(process.env.LLM_BASE_DELAY_MS, 10) || 2000;
export const MAX_BACKOFF_MS = parseInt(process.env.LLM_MAX_BACKOFF_MS, 10) || 30000;
export const CLOUD_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS, 10) || 120_000;

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function isRateLimitError(err) {
  const msg = (err?.message || "").toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  const RATE_LIMIT_CODES = new Set([429, 529]);
  if (RATE_LIMIT_CODES.has(status)) return true;
  // NOTE: no trailing `\b` on `rate.?limit` / `rate_limit` / `overloaded` —
  // `_` is a word character, so `\b` would NOT match between `t` and `_` and
  // would miss SDK error types like `rate_limit_error` and `overloaded_error`
  // (Anthropic). Pinned by `backend/tests/ai-fallback.test.js`.
  return /\b429\b/.test(msg)
    || /\b529\b/.test(msg)
    || /\brate.?limit/i.test(msg)
    || /\brate_limit/i.test(msg)
    || /\btoo many requests\b/i.test(msg)
    || /\bquota\s*(exceeded|exhausted|limit)/i.test(msg)
    || /\bresource.?exhausted\b/i.test(msg)
    || /\boverloaded/i.test(msg);
}

export function isTransientServerError(err) {
  const msg = (err?.message || "").toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  if (status >= 500 && status !== 501) return true;
  return /\b50[0234]\b/.test(msg)
    || /\bservice unavailable\b/i.test(msg)
    || /\bhigh demand\b/i.test(msg)
    || /\btry again later\b/i.test(msg)
    || /\binternal server error\b/i.test(msg)
    || /\bbad gateway\b/i.test(msg)
    || /\bgateway timeout\b/i.test(msg);
}

export function isRetryableError(err) {
  return isRateLimitError(err) || isTransientServerError(err);
}

function extractRetryAfter(err) {
  const match = (err?.message || "").match(/retry in (\d+(?:\.\d+)?)(s|ms)/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  return match[2].toLowerCase() === "ms" ? val : val * 1000;
}

export async function withRetry(fn, label = "") {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES || !isRetryableError(err)) throw err;
      const retryAfter = extractRetryAfter(err);
      const delay = retryAfter
        ? Math.min(retryAfter, MAX_BACKOFF_MS * 2)
        : Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      const reason = isRateLimitError(err) ? "Rate limit" : "Transient server error (5xx)";
      console.warn(formatLogLine("warn", null, `${reason} hit${label ? " for " + label : ""}: ${err.message?.slice(0, 120)}. Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`));
      await sleep(delay);
    }
  }
}

export function composeSignal(external, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("AI call timed out")), timeoutMs);
  let onExternal = null;
  if (external) {
    if (external.aborted) {
      clearTimeout(timer);
      controller.abort(external.reason);
    } else {
      onExternal = () => { clearTimeout(timer); controller.abort(external.reason); };
      external.addEventListener("abort", onExternal, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (onExternal && external) external.removeEventListener("abort", onExternal);
    },
  };
}
