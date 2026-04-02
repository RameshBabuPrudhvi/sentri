/**
 * aiProvider.js — Multi-AI provider abstraction for Sentri
 *
 * Supports:
 *   - Anthropic Claude  (ANTHROPIC_API_KEY)
 *   - OpenAI GPT        (OPENAI_API_KEY)
 *   - Google Gemini     (GOOGLE_API_KEY)
 *   - Ollama / local    (AI_PROVIDER=local, no key needed)
 *
 * Priority order:
 *   AI_PROVIDER env var (explicit) → auto-detect (Anthropic → OpenAI → Google → Ollama)
 *
 * Ollama env vars:
 *   OLLAMA_BASE_URL  — default: http://localhost:11434
 *   OLLAMA_MODEL     — default: llama3.2  (any model pulled with `ollama pull <name>`)
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Runtime key store (set via /api/settings, survives until process restart) ─
const runtimeKeys = {};

// Ollama runtime config (settable via /api/settings for the local provider)
let runtimeOllamaBaseUrl = "";
let runtimeOllamaModel   = "";
// Explicit deactivation flag — when true, Ollama is disabled even if env vars are set.
// Set to true by DELETE /api/settings/local; cleared by POST /api/settings with local provider.
let runtimeOllamaDisabled = false;

export function setRuntimeKey(provider, key) {
  if (provider === "anthropic") runtimeKeys.ANTHROPIC_API_KEY = key;
  if (provider === "openai")    runtimeKeys.OPENAI_API_KEY    = key;
  if (provider === "google")    runtimeKeys.GOOGLE_API_KEY    = key;
}

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
    || "llama3.2";
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

export function getProvider()     { try { return detectProvider(); } catch { return null; } }
export function hasProvider()     { return getProvider() !== null; }
export function isLocalProvider() { return getProvider() === "local"; }
export function getProviderName() {
  const p = getProvider();
  return p ? buildProviderMeta()[p].name : "No provider configured";
}
export function getProviderMeta() {
  const p = getProvider();
  return p ? { provider: p, ...buildProviderMeta()[p] } : null;
}

// Returns masked keys + Ollama config for the settings UI
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

export async function checkOllamaConnection() {
  const base = getOllamaBaseUrl();
  const model = getOllamaModel();
  try {
    const tagsRes = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!tagsRes.ok) return { ok: false, error: `Ollama /api/tags returned HTTP ${tagsRes.status}` };
    const { models = [] } = await tagsRes.json();
    const names = models.map(m => m.name.split(":")[0]);
    // model name may include a tag (llama3.2:latest) — strip for comparison
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

function isRateLimitError(err) {
  const msg = err?.message || "";
  const status = err?.status || err?.statusCode || 0;
  return RATE_LIMIT_CODES.includes(status)
    || RETRY_ERRORS.some(e => msg.includes(e))
    || msg.includes("quota")
    || msg.includes("429");
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

async function callOllama(prompt, maxTokens) {
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
      throw new Error(`Ollama request timed out after ${timeoutMs / 1000}s. Try a smaller/faster model or increase OLLAMA_TIMEOUT_MS.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Core API call ─────────────────────────────────────────────────────────────

async function callProvider(provider, prompt, maxTokens) {
  const tokens = maxTokens || DEFAULT_MAX_TOKENS;

  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: getKey("ANTHROPIC_API_KEY") });
    return withRetry(async () => {
      const msg = await client.messages.create({
        model: buildProviderMeta().anthropic.model,
        max_tokens: tokens,
        messages: [{ role: "user", content: prompt }],
      });
      return msg.content[0].text;
    }, "Anthropic");
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey: getKey("OPENAI_API_KEY") });
    return withRetry(async () => {
      const res = await client.chat.completions.create({
        model: buildProviderMeta().openai.model,
        max_tokens: tokens,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      });
      return res.choices[0].message.content;
    }, "OpenAI");
  }

  if (provider === "google") {
    const genAI = new GoogleGenerativeAI(getKey("GOOGLE_API_KEY"));
    return withRetry(async () => {
      const model = genAI.getGenerativeModel({
        model: buildProviderMeta().google.model,
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: tokens },
      });
      const result = await model.generateContent(prompt);
      return result.response.text();
    }, "Google Gemini");
  }

  if (provider === "local") {
    // Retry on connection errors AND Ollama HTTP 500s (model overload / context overflow)
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await callOllama(prompt, tokens);
      } catch (err) {
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
 * generateText(prompt, options?)
 * @param {string} prompt
 * @param {{ maxTokens?: number }} options
 */
export async function generateText(prompt, options) {
  const provider = detectProvider();
  if (!provider) {
    throw new Error(
      "No AI provider configured. Options:\n" +
      "  Cloud: set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY in backend/.env\n" +
      "  Local: set AI_PROVIDER=local (requires Ollama running at http://localhost:11434)\n" +
      "         Optionally: OLLAMA_MODEL=llama3.2  OLLAMA_BASE_URL=http://localhost:11434"
    );
  }
  return callProvider(provider, prompt, options?.maxTokens);
}

export function parseJSON(text) {
  const clean = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  return JSON.parse(clean);
}

/**
 * streamText(prompt, onToken, options?)
 *
 * Token-streaming variant of generateText().
 * Calls onToken(string) for each token as it arrives.
 * Returns the full accumulated text when the stream completes.
 *
 * Falls back to a single blocking call (Google / Ollama) that delivers
 * the entire response as one synthetic "token".
 */
export async function streamText(prompt, onToken, options = {}) {
  const provider = detectProvider();
  if (!provider) throw new Error("No AI provider configured.");

  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: getKey("ANTHROPIC_API_KEY") });
    const stream = client.messages.stream({
      model: buildProviderMeta().anthropic.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta?.text) {
        onToken(chunk.delta.text);
      }
    }
    return (await stream.finalMessage()).content[0].text;
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey: getKey("OPENAI_API_KEY") });
    const stream = await client.chat.completions.create({
      model: buildProviderMeta().openai.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });
    let full = "";
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (token) { full += token; onToken(token); }
    }
    return full;
  }

  // Google / Ollama — no streaming SDK; deliver whole response as one token
  const text = await generateText(prompt, options);
  onToken(text);
  return text;
}
