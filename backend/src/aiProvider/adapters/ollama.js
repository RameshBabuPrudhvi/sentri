import { MAX_RETRIES, BASE_DELAY_MS, MAX_BACKOFF_MS, sleep } from "../retry.js";
import { formatLogLine } from "../../utils/logFormatter.js";
import { pricingFor } from "../modelCatalog.js";

// B2.4 — adapters return raw `{ input, output }` token usage only.
// Ollama's `/api/generate` doesn't return token counts in non-streaming
// mode, but we still emit `{ input: 0, output: 0 }` for catalog-known
// local models so the dispatcher's `computeCostForRoute` can compute
// `costUsd: 0` (free local). Catalog-miss models return `usage: null`
// so the dispatcher's "no data" branch fires correctly.

const DEFAULT_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS, 10) || 16384;

/**
 * Low-level call to Ollama's /api/generate. Handles:
 *   - num_predict capping (OLLAMA_MAX_PREDICT, default 4096) — local models
 *     have small context windows and HTTP-500 on overflow.
 *   - JSON format flag (only when caller asked for structured output).
 *   - Per-call timeout (OLLAMA_TIMEOUT_MS, default 120s).
 *   - External AbortSignal forwarding + listener cleanup (prevents
 *     MaxListenersExceededWarning across long pipelines).
 *   - NDJSON fallback when Ollama returns one JSON object per line instead
 *     of a single response object.
 */
async function callOllama(prompt, maxTokens, externalSignal, useJson, baseUrl, model) {
  const OLLAMA_MAX_PREDICT = parseInt(process.env.OLLAMA_MAX_PREDICT, 10) || 4096;
  const effectiveTokens = Math.min(maxTokens || DEFAULT_MAX_TOKENS, OLLAMA_MAX_PREDICT);

  const body = {
    model,
    prompt,
    stream: false,
    options: {
      num_predict: effectiveTokens,
      temperature: 0.2,
    },
  };
  if (useJson) body.format = "json";

  const controller = new AbortController();
  const timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 120_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let onExternalAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException("Aborted", "AbortError");
    } else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // NDJSON fallback — each line is a JSON object with a partial "response"
      // field. Concatenate all response fields to reconstruct the full output.
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
        } catch { /* skip unparseable lines */ }
      }
      if (!foundAny) throw new Error(`Ollama returned unparseable response: ${raw.slice(0, 300)}`);
      data = { response: fullResponse };
    }

    if (!data.response) throw new Error(`Unexpected Ollama response shape: ${JSON.stringify(data).slice(0, 200)}`);
    return data.response;
  } catch (err) {
    if (err.name === "AbortError") {
      if (externalSignal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw new Error(`Ollama request timed out after ${timeoutMs / 1000}s. Try a smaller/faster model or increase OLLAMA_TIMEOUT_MS.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (onExternalAbort && externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Ollama adapter — implements the AI-002 adapter contract:
 *   generate({ messages, maxTokens, signal, useJson, model, baseUrl }) → { text, usage }
 *   stream  (not supported — returns null so caller falls back to generate)
 *   generateVision (not supported — returns null)
 *
 * Ollama uses the prebuilt `messages.combined` string (system + user joined)
 * because /api/generate has no system-prompt field. `apiKey` is ignored
 * (Ollama is unauthenticated by default).
 */
export async function generate({ messages, maxTokens, signal, useJson, model, baseUrl }) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await callOllama(messages.combined, maxTokens, signal, useJson, baseUrl, model);
      // B2.4 — Ollama's `/api/generate` doesn't return token counts in
      // non-streaming mode. We still emit `{ input: 0, output: 0 }` for
      // catalog-known local models so the dispatcher's
      // `computeCostForRoute` resolves to `costUsd: 0` (free). For
      // unknown models we return `usage: null` so the dispatcher's
      // "no data" branch fires (skipping the cost metric) — distinguishing
      // "free local model" from "no data" matches the dashboard contract.
      const known = pricingFor(model);
      const usage = known ? { input: 0, output: 0 } : null;
      return { text, usage };
    } catch (err) {
      if (err.name === "AbortError" || signal?.aborted) throw err;
      const isRetryable = err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed") || err.message.includes("Ollama HTTP 500");
      if (attempt === MAX_RETRIES || !isRetryable) throw err;
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      console.warn(formatLogLine("warn", null, `[Ollama] ${err.message.slice(0, 80)}. Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`));
      await sleep(delay);
    }
  }
  return { text: "", usage: null };
}

export async function stream() { return null; }
export async function generateVision() { return null; }
