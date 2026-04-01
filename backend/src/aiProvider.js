/**
 * aiProvider.js — Multi-AI provider abstraction for Sentri
 *
 * Supports runtime key injection via /api/settings (no restart needed).
 * Auto-detects provider from available keys.
 * Handles rate limits with exponential backoff + retry.
 *
 * Priority order: AI_PROVIDER env var → auto-detect (Anthropic → OpenAI → Google)
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Runtime key store (set via /api/settings, survives until process restart) ─
const runtimeKeys = {};

// Ollama runtime config (base URL + model) — set via /api/settings
const ollamaConfig = {
  baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  model:   process.env.OLLAMA_MODEL    || "llama3.1",
};

export function setRuntimeKey(provider, key) {
  if (provider === "anthropic") runtimeKeys.ANTHROPIC_API_KEY = key;
  if (provider === "openai")    runtimeKeys.OPENAI_API_KEY = key;
  if (provider === "google")    runtimeKeys.GOOGLE_API_KEY = key;
  if (provider === "ollama") {
    // For Ollama, the "key" is a JSON payload: { baseUrl, model }
    // or a simple truthy string "enabled" to activate with defaults.
    runtimeKeys.OLLAMA_ENABLED = key ? "1" : "";
    if (key && typeof key === "string" && key.startsWith("{")) {
      try {
        const cfg = JSON.parse(key);
        if (cfg.baseUrl) ollamaConfig.baseUrl = cfg.baseUrl;
        if (cfg.model)   ollamaConfig.model   = cfg.model;
      } catch { /* use defaults */ }
    } else if (!key) {
      // Reset to defaults when disabling so stale config doesn't persist
      ollamaConfig.baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
      ollamaConfig.model   = process.env.OLLAMA_MODEL    || "llama3.1";
    }
  }
}

export function getOllamaConfig() {
  return { ...ollamaConfig };
}

function getKey(envName) {
  return runtimeKeys[envName] || process.env[envName] || "";
}

// ── Provider info ─────────────────────────────────────────────────────────────

const PROVIDER_META = {
  anthropic: { name: "Claude Sonnet",         model: "claude-sonnet-4-20250514", color: "#cd7f32" },
  openai:    { name: "GPT-4o-mini",           model: "gpt-4o-mini",              color: "#10a37f" },
  google:    { name: "Gemini 2.5 Flash",      model: "gemini-2.5-flash",         color: "#4285f4" },
  ollama:    { name: "Ollama (Local)",        model: ollamaConfig.model,          color: "#6b7280" },
};

function isOllamaEnabled() {
  return !!(getKey("OLLAMA_ENABLED") || process.env.OLLAMA_ENABLED);
}

function detectProvider() {
  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced && PROVIDER_META[forced]) {
    const keyMap = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_API_KEY", ollama: "OLLAMA_ENABLED" };
    if (forced === "ollama") {
      if (!isOllamaEnabled()) throw new Error(`AI_PROVIDER="ollama" but Ollama is not enabled`);
      return "ollama";
    }
    if (!getKey(keyMap[forced])) {
      throw new Error(`AI_PROVIDER="${forced}" but ${keyMap[forced]} is not set`);
    }
    return forced;
  }
  if (getKey("ANTHROPIC_API_KEY")) return "anthropic";
  if (getKey("OPENAI_API_KEY"))    return "openai";
  if (getKey("GOOGLE_API_KEY"))    return "google";
  if (isOllamaEnabled())           return "ollama";
  return null;
}

export function getProvider()     { try { return detectProvider(); } catch { return null; } }
export function hasProvider()     { return getProvider() !== null; }
export function getProviderName() {
  const p = getProvider();
  if (!p) return "No provider configured";
  // Ollama model is dynamic — always read from current config
  if (p === "ollama") return `Ollama (${ollamaConfig.model})`;
  return PROVIDER_META[p].name;
}
export function getProviderMeta() {
  const p = getProvider();
  if (!p) return null;
  const meta = { provider: p, ...PROVIDER_META[p] };
  // Ollama model is dynamic — always read from current config
  if (p === "ollama") {
    meta.model = ollamaConfig.model;
    meta.name  = `Ollama (${ollamaConfig.model})`;
  }
  return meta;
}

// Returns masked keys for the settings UI (never expose full keys)
export function getConfiguredKeys() {
  return {
    anthropic: maskKey(getKey("ANTHROPIC_API_KEY")),
    openai:    maskKey(getKey("OPENAI_API_KEY")),
    google:    maskKey(getKey("GOOGLE_API_KEY")),
    ollama:    isOllamaEnabled() ? `${ollamaConfig.baseUrl} · ${ollamaConfig.model}` : "",
    ollamaConfig: isOllamaEnabled() ? { ...ollamaConfig } : null,
    activeProvider: getProvider(),
  };
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 6) + "••••••••" + key.slice(-4);
}

// ── Retry with exponential backoff ────────────────────────────────────────────

const RATE_LIMIT_CODES  = [429, 529];
const RETRY_ERRORS      = ["rate_limit_error", "overloaded_error", "Too Many Requests"];
const MAX_RETRIES       = parseInt(process.env.LLM_MAX_RETRIES, 10) || 3;
const BASE_DELAY_MS     = parseInt(process.env.LLM_BASE_DELAY_MS, 10) || 2000;

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
  // Gemini includes "retry in Xs" in the message
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

// ── Core API call ─────────────────────────────────────────────────────────────

// 16384 tokens allows 10-15 complete Playwright tests with full code,
// supporting the new two-phase PLAN+GENERATE pipeline in journeyGenerator.js
// where the planning prompt alone can consume ~2k tokens.
// The previous 8192 limit caused truncation on large journey test batches.
const DEFAULT_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS, 10) || 16384;

async function callProvider(provider, prompt, maxTokens) {
  const tokens = maxTokens || DEFAULT_MAX_TOKENS;

  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: getKey("ANTHROPIC_API_KEY") });
    return withRetry(async () => {
      const msg = await client.messages.create({
        model: PROVIDER_META.anthropic.model,
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
        model: PROVIDER_META.openai.model,
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
        model: PROVIDER_META.google.model,
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: tokens },
      });
      const result = await model.generateContent(prompt);
      return result.response.text();
    }, "Google Gemini");
  }

  if (provider === "ollama") {
    // Ollama exposes an OpenAI-compatible API — reuse the openai SDK
    const client = new OpenAI({
      baseURL: `${ollamaConfig.baseUrl}/v1`,
      apiKey:  "ollama", // Ollama doesn't require a real key
    });
    return withRetry(async () => {
      const res = await client.chat.completions.create({
        model: ollamaConfig.model,
        max_tokens: tokens,
        // Not all Ollama models support json_object, but those that do
        // (llama3.1, mistral, etc.) will return cleaner output with it.
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      });
      return res.choices[0].message.content;
    }, "Ollama");
  }

  throw new Error(`Unknown provider: ${provider}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * generateText(prompt, options?)
 *
 * @param {string} prompt
 * @param {{ maxTokens?: number }} options
 */
export async function generateText(prompt, options) {
  const provider = detectProvider();
  if (!provider) {
    throw new Error(
      "No AI API key configured. Set one in Settings or add to backend/.env:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...   → https://console.anthropic.com\n" +
      "  OPENAI_API_KEY=sk-...          → https://platform.openai.com/api-keys\n" +
      "  GOOGLE_API_KEY=AIza...         → https://aistudio.google.com/apikey\n" +
      "  OLLAMA_ENABLED=1               → Local models via Ollama (no API key needed)"
    );
  }
  return callProvider(provider, prompt, options?.maxTokens);
}

/**
 * validateProvider(provider)
 *
 * Makes a minimal API call to the specified provider to verify the key works.
 * Unlike generateText(), this does NOT auto-detect — it targets the exact provider.
 */
export async function validateProvider(provider) {
  if (!PROVIDER_META[provider]) throw new Error(`Unknown provider: ${provider}`);
  return callProvider(provider, 'Respond with exactly: {"ok":true}', 32);
}

export function parseJSON(text) {
  const clean = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  return JSON.parse(clean);
}
