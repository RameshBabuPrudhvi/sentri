/**
 * @module aiProvider/protocols/ollama
 * @description B1.5 — Protocol module for Ollama's `/api/generate` HTTP
 *   endpoint (also covers any vendor that speaks the Ollama wire format).
 *
 * Route-driven counterpart to `backend/src/aiProvider/adapters/ollama.js`.
 * See `protocols/openai.js` for the contract docs.
 *
 * Ollama-specific notes:
 *   • `route.baseUrl` is required (Ollama is self-hosted; there's no
 *     canonical default we can infer).
 *   • API key is OPTIONAL on this protocol — most Ollama deployments are
 *     unauthenticated. Routes against an authenticated gateway can still
 *     pass `opts.apiKey` and we forward it as a Bearer header.
 *   • `messages.combined` is used because `/api/generate` has no system
 *     message field — the orchestrator's `normaliseMessages` merges
 *     system + user into one prompt before we get here.
 *   • Native incremental streaming via Ollama's `stream: true` mode IS
 *     supported by the daemon, but the legacy adapter doesn't expose it
 *     and dispatch falls back to single-token emission. We mirror that
 *     for parity — `stream()` returns `null` so the orchestrator's
 *     fallback path activates. A future bundle can add NDJSON streaming
 *     here without touching callers.
 *   • Token usage is not returned by `/api/generate` in non-streaming
 *     mode. We attach a synthetic `{ input: 0, output: 0 }` block when
 *     the model is in the catalog so dashboards can distinguish "free
 *     local model" from "no data" — same pattern as the legacy adapter.
 */

import { MAX_RETRIES, BASE_DELAY_MS, MAX_BACKOFF_MS, sleep } from "../retry.js";
import { formatLogLine } from "../../utils/logFormatter.js";
import { pricingFor } from "../modelCatalog.js";

// Per-attempt fetch timeout — defaults to `DEFAULT_OLLAMA_TIMEOUT_MS`
// (120s, set below) for dispatch traffic. Capability probes pass
// `opts.attemptTimeoutMs` (typically 15s) so a connection-refused
// probe against a local Ollama daemon that isn't running fails fast
// instead of waiting out the dispatch budget. `opts.timeoutMs` is
// retained as the lower-precedence override path so existing call
// sites that set `timeoutMs` aren't affected.
//
// Resolution order (highest to lowest):
//   1. `opts.attemptTimeoutMs` — new probe-driven knob.
//   2. `opts.timeoutMs`        — pre-existing field used by tests +
//                                future per-call overrides.
//   3. `DEFAULT_OLLAMA_TIMEOUT_MS` — the 120s baseline.
function resolveAttemptTimeoutMs(opts) {
  if (Number.isFinite(opts.attemptTimeoutMs)) return opts.attemptTimeoutMs;
  if (Number.isFinite(opts.timeoutMs)) return opts.timeoutMs;
  return DEFAULT_OLLAMA_TIMEOUT_MS;
}

// B2.4 — protocol modules return raw `{ input, output }` token usage
// only. For Ollama (which doesn't expose token counts in non-streaming
// mode), we emit `{ input: 0, output: 0 }` for catalog-known local
// models so the dispatcher's `computeCostForRoute` resolves to
// `costUsd: 0` (free). Unknown models return `usage: null` so the
// dispatcher's "no data" branch fires correctly.

const DEFAULT_OLLAMA_TIMEOUT_MS = 120_000;
const DEFAULT_OLLAMA_MAX_PREDICT = 4096;

/**
 * Single low-level call to `/api/generate`. Self-contained — no env reads
 * (the legacy adapter's `OLLAMA_TIMEOUT_MS` / `OLLAMA_MAX_PREDICT` env
 * vars are read by the orchestrator and passed in via `opts` if a
 * caller wants to override; the defaults above are baked into this
 * module so a route alone is sufficient to fire a request).
 */
async function callOllama(route, messages, opts) {
  const maxPredict = opts.maxPredict || DEFAULT_OLLAMA_MAX_PREDICT;
  const effectiveTokens = Math.min(opts.maxTokens || maxPredict, maxPredict);
  const body = {
    model: route.model,
    prompt: messages.combined,
    stream: false,
    options: { num_predict: effectiveTokens, temperature: 0.2 },
  };
  if (opts.useJson) body.format = "json";

  const controller = new AbortController();
  // See `resolveAttemptTimeoutMs` JSDoc — probes override via
  // `attemptTimeoutMs`, dispatch uses `timeoutMs` (or the 120s default).
  const timeoutMs = resolveAttemptTimeoutMs(opts);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let onExternalAbort = null;
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException("Aborted", "AbortError");
    }
    onExternalAbort = () => controller.abort();
    opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const res = await fetch(`${route.baseUrl}/api/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      // NDJSON fallback — daemon sometimes returns one JSON object per
      // line even when stream=false. Concatenate the `response` fields.
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      let fullResponse = "";
      let foundAny = false;
      for (const line of lines) {
        try {
          const candidate = JSON.parse(line);
          if (candidate.response !== undefined) {
            fullResponse += candidate.response;
            foundAny = true;
          }
        } catch { /* skip unparseable */ }
      }
      if (!foundAny) throw new Error(`Ollama returned unparseable response: ${raw.slice(0, 300)}`);
      data = { response: fullResponse };
    }
    if (data.response === undefined) {
      throw new Error(`Unexpected Ollama response shape: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data.response;
  } catch (err) {
    if (err.name === "AbortError") {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw new Error(`Ollama request timed out after ${timeoutMs / 1000}s. Try a smaller/faster model or raise opts.timeoutMs.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (onExternalAbort && opts.signal) {
      opts.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export async function generate(route, messages, opts) {
  if (!route.baseUrl) {
    throw new Error("ollama protocol generate(): route.baseUrl is required");
  }
  // `opts.maxRetries` honours the same probe fast-fail contract as
  // `protocols/openai.js#generate` (which forwards it to `withRetry`).
  // Ollama has its own manual retry loop because it retries on a
  // narrower error set (ECONNREFUSED / fetch failed / Ollama 500 —
  // the local-daemon-down signals) than the cloud `withRetry` (which
  // retries on rate-limit + 5xx). The opt-in is the same: probes pass
  // `0` to skip retries entirely so a daemon-not-running surfaces in
  // a single fetch attempt (~15s) rather than the legacy ~113s chain.
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const text = await callOllama(route, messages, opts);
      // B2.4 — distinguish "free local model" (catalog hit → `{0, 0}`
      // → dispatcher computes costUsd: 0) from "unknown model"
      // (catalog miss → `usage: null` → dispatcher skips cost metric).
      // The dispatcher's `computeCostForRoute` owns the cost math;
      // protocol modules only signal which case applies.
      const known = pricingFor(route.model);
      const usage = known ? { input: 0, output: 0 } : null;
      return { text, usage };
    } catch (err) {
      if (err.name === "AbortError" || opts.signal?.aborted) throw err;
      const isRetryable = err.message.includes("ECONNREFUSED")
        || err.message.includes("fetch failed")
        || err.message.includes("Ollama HTTP 500");
      if (attempt === maxRetries || !isRetryable) throw err;
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      console.warn(formatLogLine("warn", null,
        `[ollama-protocol] ${err.message.slice(0, 80)}. Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`));
      // Honour the caller's abort signal during the backoff sleep so
      // a probe deadline / dispatch budget can cancel the retry chain
      // instead of waiting out the full delay. Mirrors `retry.js`'s
      // signal-aware sleep added for the same fast-fail rationale.
      await sleep(delay, opts.signal);
    }
  }
  return { text: "", usage: null };
}

/**
 * Native streaming intentionally not implemented in B1.5 — returning
 * `null` signals {@link protocolAdapter#stream} to fall back to
 * non-streaming `generate()` and emit the full response as a single
 * synthetic token. Matches the legacy adapter's behaviour and keeps
 * the bundle scope tight.
 */
export async function stream() { return null; }

/**
 * Ollama models served via `/api/generate` are predominantly text-only;
 * vision-capable local models (LLaVA, Bakllava, etc.) exist but are
 * niche enough that we don't ship a built-in adapter for them. Returning
 * `null` signals {@link protocolAdapter#generateVision} to surface the
 * "no vision on this protocol" path — vision-heal falls through to
 * `null` and the caller degrades to non-LLM healing (the same behaviour
 * as the pre-B2 legacy adapter, which also returned `null` here).
 *
 * Future work: an opt-in `vision: true` capability flag on the route
 * row would let `protocolAdapter.generateVision` route the call through
 * the OpenAI-protocol module instead (LLaVA via Ollama exposes an
 * OpenAI-compatible `/v1/chat/completions` endpoint). That's a B4+
 * feature gated on operator demand.
 */
export async function generateVision() { return null; }
