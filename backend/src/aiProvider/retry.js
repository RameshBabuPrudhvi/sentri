import { formatLogLine } from "../utils/logFormatter.js";

export const MAX_RETRIES = parseInt(process.env.LLM_MAX_RETRIES, 10) || 3;
export const BASE_DELAY_MS = parseInt(process.env.LLM_BASE_DELAY_MS, 10) || 2000;
export const MAX_BACKOFF_MS = parseInt(process.env.LLM_MAX_BACKOFF_MS, 10) || 30000;
export const CLOUD_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS, 10) || 120_000;

/**
 * Sleep for `ms`, but reject early if `signal` aborts. Without the signal
 * branch, an in-flight `withRetry` chain could hold the event loop for
 * the full backoff window after the caller had already abandoned the
 * call — see `capabilityProbe.runCapabilityProbe`'s overall-deadline
 * race for the symptom (probe wall-clock exceeded `probeTimeoutMs`
 * because the inter-attempt sleep ignored aborts).
 *
 * Rejects with the signal's `reason` (or `new Error("aborted")`) when
 * the signal fires; resolves normally on the timeout. The timer is
 * cleared either way so a long sleep can't keep the process alive
 * past shutdown.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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

/**
 * Run `fn` with exponential-backoff retries on rate-limit / 5xx errors.
 *
 * When `signal` is supplied (typically the same signal threaded into
 * `fn` via `composeSignal`), the inter-attempt sleep aborts early on
 * signal fire. This makes `withRetry` honour caller-imposed wall-clock
 * budgets — without it, a `probeTimeoutMs: 90000` budget could stretch
 * to 117s because the 30s+ backoff sleep ignored the abort signal.
 *
 * @param {Function} fn - The work function. Receives no args; must
 *   handle its own per-attempt signal composition.
 * @param {string} [label] - Diagnostic label for retry log lines.
 * @param {AbortSignal} [signal] - Optional signal that cancels the
 *   inter-attempt sleep. Does NOT cancel `fn` itself — `fn` is
 *   responsible for honouring its own signal.
 */
export async function withRetry(fn, label = "", signal = undefined) {
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
      // Honour the caller's abort signal during the backoff sleep so
      // a budget overrun cancels the retry chain instead of waiting
      // out the full delay. `sleep` rejects when the signal fires;
      // re-throw so callers see the abort (not a stale retryable err).
      await sleep(delay, signal);
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
