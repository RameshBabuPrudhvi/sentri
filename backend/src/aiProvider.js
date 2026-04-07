/**
 * @module aiProvider
 * @description Multi-AI provider abstraction layer.
 *
 * ### Supported providers
 * | Provider         | Env Variable        | Default Model              |
 * |------------------|---------------------|----------------------------|
 * | Anthropic Claude | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514   |
 * | OpenAI GPT       | `OPENAI_API_KEY`    | gpt-4o-mini                |
 * | Google Gemini    | `GOOGLE_API_KEY`    | gemini-2.5-flash           |
 * | Ollama (local)   | `AI_PROVIDER=local` | mistral:7b (configurable)    |
 *
 * **Detection order:** `AI_PROVIDER` env var (explicit) → auto-detect (Anthropic → OpenAI → Google → Ollama).
 *
 * ### Exports
 * - {@link generateText} — Single-shot text generation.
 * - {@link streamText} — Token-streaming text generation (Anthropic/OpenAI; fallback for others).
 * - {@link parseJSON} — Parse AI response text as JSON (strips markdown fences).
 * - {@link getProvider}, {@link hasProvider}, {@link isLocalProvider}, {@link getProviderName}, {@link getProviderMeta} — Provider detection.
 * - {@link setRuntimeKey}, {@link setRuntimeOllama} — Runtime configuration (Settings page).
 * - {@link getConfiguredKeys} — Masked key status for the Settings UI.
 * - {@link checkOllamaConnection} — Ollama connectivity check.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { throwIfAborted } from "./utils/abortHelper.js";

// ── Runtime key store (set via /api/settings, survives until process restart) ─
const runtimeKeys = {};

// Ollama runtime config (settable via /api/settings for the local provider)
let runtimeOllamaBaseUrl = "";
let runtimeOllamaModel   = "";
// Explicit deactivation flag — when true, Ollama is disabled even if env vars are set.
// Set to true by DELETE /api/settings/local; cleared by POST /api/settings with local provider.
let runtimeOllamaDisabled = false;

/**
 * Set an AI provider API key at runtime (via Settings page).
 * @param {string} provider - `"anthropic"` | `"openai"` | `"google"`.
 * @param {string} key      - The API key string.
 */
export function setRuntimeKey(provider, key) {
  if (provider === "anthropic") runtimeKeys.ANTHROPIC_API_KEY = key;
  if (provider === "openai")    runtimeKeys.OPENAI_API_KEY    = key;
  if (provider === "google")    runtimeKeys.GOOGLE_API_KEY    = key;
}

/**
 * Configure Ollama runtime settings (via Settings page).
 * @param {Object}  [opts]
 * @param {string}  [opts.baseUrl]  - Ollama server URL.
 * @param {string}  [opts.model]    - Model name (e.g. `"mistral:7b"`).
 * @param {boolean} [opts.disabled] - Set `true` to deactivate Ollama.
 */
export function setRuntimeOllama({ baseUrl, model, disabled } = {}) {
  if (baseUrl  !== undefined) runtimeOllamaBaseUrl  = baseUrl;
  if (model    !== undefined) runtimeOllamaModel    = model;
  if (disabled !== undefined) runtimeOllamaDisabled = disabled;
}

function getKey(envName) {
  // Use `in` + explicit check so that setting a runtime key to "" (deactivation)
  // takes precedence over the env var. Previously `||` made "" falsy, falling
  // through to process.env and making runtime deactivation impossible.
  if (envName in runtimeKeys) return runtimeKeys[envName];
  return process.env[envName] || "";
}

function getOllamaBaseUrl() {
  return runtimeOllamaBaseUrl
    || process.env.OLLAMA_BASE_URL
    || "http://localhost:11434";
}

function getOllamaModel() {
  return runtimeOllamaModel
    || process.env.OLLAMA_MODEL
    || "mistral:7b";
}

// ── Provider metadata ─────────────────────────────────────────────────────────

function buildProviderMeta() {
  return {
    anthropic: { name: "Claude Sonnet",    model: "claude-sonnet-4-20250514", color: "#cd7f32" },
    openai:    { name: "GPT-4o-mini",      model: "gpt-4o-mini",              color: "#10a37f" },
    google:    { name: "Gemini 2.5 Flash", model: "gemini-2.5-flash",         color: "#4285f4" },
    local:     { name: `Ollama (${getOllamaModel()})`, model: getOllamaModel(), color: "#7c3aed" },
  };
}

// ── Provider detection ────────────────────────────────────────────────────────

function detectProvider() {
  const forced = process.env.AI_PROVIDER?.toLowerCase();

  if (forced) {
    if (forced === "local") {
      // Ollama needs no API key — just check the server is reachable at runtime
      return "local";
    }
    const keyMap = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_API_KEY" };
    if (!keyMap[forced]) throw new Error(`Unknown AI_PROVIDER="${forced}". Valid: anthropic, openai, google, local`);
    if (!getKey(keyMap[forced])) throw new Error(`AI_PROVIDER="${forced}" but ${keyMap[forced]} is not set`);
    return forced;
  }

  if (getKey("ANTHROPIC_API_KEY")) return "anthropic";
  if (getKey("OPENAI_API_KEY"))    return "openai";
  if (getKey("GOOGLE_API_KEY"))    return "google";

  // Auto-detect Ollama as last resort if runtime or env model/url has been set
  // Skip if explicitly deactivated via DELETE /api/settings/local
  if (!runtimeOllamaDisabled && (runtimeOllamaBaseUrl || runtimeOllamaModel || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL)) {
    return "local";
  }

  return null;
}

/** @returns {string|null} Current provider ID (`"anthropic"`, `"openai"`, `"google"`, `"local"`), or `null`. */
export function getProvider()     { try { return detectProvider(); } catch { return null; } }
/** @returns {boolean} `true` if any AI provider is configured. */
export function hasProvider()     { return getProvider() !== null; }
/** @returns {boolean} `true` if the active provider is Ollama (local). */
export function isLocalProvider() { return getProvider() === "local"; }
/** @returns {string} Human-readable provider name (e.g. `"Claude Sonnet"`), or `"No provider configured"`. */
export function getProviderName() {
  const p = getProvider();
  return p ? buildProviderMeta()[p].name : "No provider configured";
}
/** @returns {{provider: string, name: string, model: string, color: string}|null} Full provider metadata, or `null`. */
export function getProviderMeta() {
  const p = getProvider();
  return p ? { provider: p, ...buildProviderMeta()[p] } : null;
}

/**
 * Returns masked API keys and Ollama config for the Settings UI.
 * Never returns full keys — only masked versions for display.
 *
 * @returns {{anthropic: string, openai: string, google: string, activeProvider: string|null, ollamaBaseUrl: string, ollamaModel: string}}
 */
export function getConfiguredKeys() {
  const p = getProvider();
  return {
    anthropic: maskKey(getKey("ANTHROPIC_API_KEY")),
    openai:    maskKey(getKey("OPENAI_API_KEY")),
    google:    maskKey(getKey("GOOGLE_API_KEY")),
    activeProvider: p,
    // Ollama-specific fields (never sensitive, no masking needed)
    ollamaBaseUrl: getOllamaBaseUrl(),
    ollamaModel:   getOllamaModel(),
  };
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 6) + "••••••••" + key.slice(-4);
}

// ── Ollama connectivity check ─────────────────────────────────────────────────

/**
 * Check Ollama server connectivity and verify the configured model is available.
 *
 * @returns {Promise<Object>} Resolves to `{ok: boolean, model?: string, baseUrl?: string, availableModels?: string[], error?: string}`.
 */
export async function checkOllamaConnection() {
  const base = getOllamaBaseUrl();
  const model = getOllamaModel();
  try {
    const tagsRes = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!tagsRes.ok) return { ok: false, error: `Ollama /api/tags returned HTTP ${tagsRes.status}` };
    const { models = [] } = await tagsRes.json();
    const names = models.map(m => m.name.split(":")[0]);
    // model name may include a tag (mistral:7b:latest) — strip for comparison
    const modelBase = model.split(":")[0];
    const found = names.some(n => n === modelBase || n === model);
    if (!found) {
      return {
        ok: false,
        error: `Model "${model}" not found. Run: ollama pull ${model}\nAvailable: ${names.join(", ") || "(none)"}`,
        availableModels: models.map(m => m.name),
      };
    }
    return { ok: true, model, baseUrl: base, availableModels: models.map(m => m.name) };
  } catch (err) {
    return {
      ok: false,
      error: `Cannot reach Ollama at ${base}. Is it running? (ollama serve)\nDetail: ${err.message}`,
    };
  }
}

// ── Retry with exponential backoff ────────────────────────────────────────────

const RATE_LIMIT_CODES = [429, 529];
const RETRY_ERRORS     = ["rate_limit_error", "overloaded_error", "Too Many Requests"];
const MAX_RETRIES      = parseInt(process.env.LLM_MAX_RETRIES, 10)  || 3;
const BASE_DELAY_MS    = parseInt(process.env.LLM_BASE_DELAY_MS, 10) || 2000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Detect whether an error is a rate limit / quota exhaustion from any AI provider.
 * Used internally for retry decisions and exported for the pipeline to detect
 * rate limits that survived all retries.
 *
 * @param {Error} err
 * @returns {boolean}
 */
export function isRateLimitError(err) {
  const msg = (err?.message || "").toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  if (RATE_LIMIT_CODES.includes(status)) return true;
  // Use word-boundary-aware patterns to avoid false positives on port
  // numbers (e.g. "localhost:4290"), disk quota errors, etc.
  return /\brate.?limit/i.test(msg)
    || /\brate_limit/i.test(msg)
    || /\b429\b/.test(msg)
    || /\bquota\s*(exceeded|exhausted|limit)/i.test(msg)
    || /\btoo many requests\b/i.test(msg)
    || /\bresource.?exhausted\b/i.test(msg);
}

function extractRetryAfter(err) {
  const match = (err?.message || "").match(/retry in (\d+(?:\.\d+)?)(s|ms)/i);
  if (match) {
    const val = parseFloat(match[1]);
    return match[2].toLowerCase() === "ms" ? val : val * 1000;
  }
  return null;
}

async function withRetry(fn, label = "") {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      if (!isRateLimitError(err)) throw err;
      const retryAfter = extractRetryAfter(err);
      const delay = retryAfter || BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[Sentri] Rate limit hit${label ? " for " + label : ""}. Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
    }
  }
}

// ── Core constants ────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS, 10) || 16384;

// ── Ollama caller ─────────────────────────────────────────────────────────────

async function callOllama(prompt, maxTokens, externalSignal) {
  const base  = getOllamaBaseUrl();
  const model = getOllamaModel();

  // Local models (especially 7B) have much smaller effective context windows.
  // Cap num_predict so the prompt + output don't exceed the model's limits.
  // Ollama returns HTTP 500 when the combined size overflows.
  const OLLAMA_MAX_PREDICT = parseInt(process.env.OLLAMA_MAX_PREDICT, 10) || 4096;
  const effectiveTokens = Math.min(maxTokens || DEFAULT_MAX_TOKENS, OLLAMA_MAX_PREDICT);

  const body = {
    model,
    prompt,
    stream: false,
    options: {
      // Ollama uses num_predict for max tokens
      num_predict: effectiveTokens,
      temperature: 0.2,   // Low temp — we want deterministic JSON output
    },
    // Ask Ollama to return JSON when the model supports it
    format: "json",
  };

  const controller = new AbortController();
  // Ollama can be slow for large prompts — give it generous time
  const timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 120_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // If an external abort signal is provided (e.g. user clicked "Stop Task"),
  // forward it to our internal controller so the fetch is cancelled immediately.
  // We keep a reference to the handler so we can remove it in `finally` —
  // without cleanup, 60+ sequential AI calls sharing one signal would trigger
  // a MaxListenersExceededWarning.
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
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    // Ollama with stream:false should return a single JSON object, but some
    // versions return NDJSON (one JSON object per line). We read as text and
    // handle both formats.
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // NDJSON fallback — each line is a JSON object with a partial "response"
      // field (one token per line). Concatenate all response fields to
      // reconstruct the full output, since the final done:true line typically
      // has an empty response.
      const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
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

    // Ollama returns { response: "..." } for non-streaming generate
    if (!data.response) throw new Error(`Unexpected Ollama response shape: ${JSON.stringify(data).slice(0, 200)}`);
    return data.response;
  } catch (err) {
    if (err.name === "AbortError") {
      // Distinguish user-initiated abort from internal timeout
      if (externalSignal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
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

// ─── Structured message helpers ───────────────────────────────────────────────
// Prompt builders can pass either a plain string or { system, user } to
// generateText / streamText. These helpers normalise both shapes into the
// provider-specific message format.

function normaliseMessages(promptOrMessages) {
  if (typeof promptOrMessages === "string") {
    // Legacy: single string → user-only message (backwards compatible)
    return { system: null, user: promptOrMessages, combined: promptOrMessages };
  }
  const { system, user } = promptOrMessages;
  // Combined fallback for providers that don't support system messages (Ollama)
  const combined = system ? `${system}\n\n---\n\n${user}` : user;
  return { system: system || null, user, combined };
}

// ── Core API call ─────────────────────────────────────────────────────────────

async function callProvider(provider, promptOrMessages, maxTokens, signal) {
  const tokens = maxTokens || DEFAULT_MAX_TOKENS;
  const { system, user, combined } = normaliseMessages(promptOrMessages);

  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: getKey("ANTHROPIC_API_KEY") });
    return withRetry(async () => {
      const params = {
        model: buildProviderMeta().anthropic.model,
        max_tokens: tokens,
        messages: [{ role: "user", content: user }],
      };
      // Anthropic natively supports a top-level "system" field
      if (system) params.system = system;
      const msg = await client.messages.create(params, { signal });
      return msg.content[0].text;
    }, "Anthropic");
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey: getKey("OPENAI_API_KEY") });
    return withRetry(async () => {
      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: user });
      const res = await client.chat.completions.create({
        model: buildProviderMeta().openai.model,
        max_tokens: tokens,
        response_format: { type: "json_object" },
        messages,
      }, { signal });
      return res.choices[0].message.content;
    }, "OpenAI");
  }

  if (provider === "google") {
    const genAI = new GoogleGenerativeAI(getKey("GOOGLE_API_KEY"));
    return withRetry(async () => {
      const modelConfig = {
        model: buildProviderMeta().google.model,
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: tokens },
      };
      // Gemini supports systemInstruction for system-level context
      if (system) modelConfig.systemInstruction = { parts: [{ text: system }] };
      const model = genAI.getGenerativeModel(modelConfig);
      const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: user }] }] }, { signal });
      return result.response.text();
    }, "Google Gemini");
  }

  if (provider === "local") {
    // Ollama doesn't support system messages in /api/generate — use combined prompt
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await callOllama(combined, tokens, signal);
      } catch (err) {
        // Don't retry if the user aborted
        if (err.name === "AbortError" || signal?.aborted) throw err;
        const isRetryable =
          err.message.includes("ECONNREFUSED") ||
          err.message.includes("fetch failed") ||
          err.message.includes("Ollama HTTP 500");
        if (attempt === MAX_RETRIES || !isRetryable) throw err;
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[Sentri/Ollama] ${err.message.slice(0, 80)}. Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(`Unknown provider: ${provider}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate text from an AI provider (single-shot, non-streaming).
 * Automatically detects the active provider and routes the request.
 *
 * @param {string|{system: string, user: string}} prompt - Plain string or structured `{ system, user }` messages.
 * @param {Object}      [options]
 * @param {number}      [options.maxTokens] - Max output tokens (default 16384).
 * @param {AbortSignal} [options.signal]    - Abort signal for cancellation.
 * @returns {Promise<string>} The generated text response.
 * @throws {Error} If no AI provider is configured.
 */
export async function generateText(prompt, options) {
  const provider = detectProvider();
  if (!provider) {
    throw new Error(
      "No AI provider configured. Options:\n" +
      "  Cloud: set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY in backend/.env\n" +
      "  Local: set AI_PROVIDER=local (requires Ollama running at http://localhost:11434)\n" +
      "         Optionally: OLLAMA_MODEL=mistral:7b  OLLAMA_BASE_URL=http://localhost:11434"
    );
  }
  return callProvider(provider, prompt, options?.maxTokens, options?.signal);
}

/**
 * Parse AI response text as JSON. Strips markdown code fences if present.
 *
 * @param {string} text - Raw AI response text.
 * @returns {Object} Parsed JSON object.
 * @throws {SyntaxError} If the text is not valid JSON after cleanup.
 */
export function parseJSON(text) {
  const clean = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  return JSON.parse(clean);
}

/**
 * Token-streaming variant of {@link generateText}.
 * Calls `onToken(string)` for each token as it arrives.
 * Returns the full accumulated text when the stream completes.
 *
 * Falls back to a single blocking call (Google / Ollama) that delivers
 * the entire response as one synthetic "token".
 *
 * @param {string|{system: string, user: string}} promptOrMessages - Plain string or structured messages.
 * @param {function(string): void} onToken - Callback invoked for each token.
 * @param {Object}      [options]
 * @param {number}      [options.maxTokens] - Max output tokens.
 * @param {AbortSignal} [options.signal]    - Abort signal for cancellation.
 * @returns {Promise<string>} The full accumulated response text.
 * @throws {Error} If no AI provider is configured.
 */
export async function streamText(promptOrMessages, onToken, options = {}) {
  const provider = detectProvider();
  if (!provider) throw new Error("No AI provider configured.");

  const { signal } = options;
  const { system, user, combined } = normaliseMessages(promptOrMessages);

  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: getKey("ANTHROPIC_API_KEY") });
    const params = {
      model: buildProviderMeta().anthropic.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: user }],
    };
    if (system) params.system = system;
    const stream = client.messages.stream(params, { signal });
    for await (const chunk of stream) {
      throwIfAborted(signal);
      if (chunk.type === "content_block_delta" && chunk.delta?.text) {
        onToken(chunk.delta.text);
      }
    }
    return (await stream.finalMessage()).content[0].text;
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey: getKey("OPENAI_API_KEY") });
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });
    const stream = await client.chat.completions.create({
      model: buildProviderMeta().openai.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      response_format: { type: "json_object" },
      messages,
    }, { signal });
    let full = "";
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (token) { full += token; onToken(token); }
    }
    return full;
  }

  // Google / Ollama — no streaming SDK; deliver whole response as one token
  const text = await generateText(promptOrMessages, options);
  onToken(text);
  return text;
}
