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

export function setRuntimeKey(provider, key) {
  if (provider === "anthropic") runtimeKeys.ANTHROPIC_API_KEY = key;
  if (provider === "openai")    runtimeKeys.OPENAI_API_KEY = key;
  if (provider === "google")    runtimeKeys.GOOGLE_API_KEY = key;
}

function getKey(envName) {
  return runtimeKeys[envName] || process.env[envName] || "";
}

// ── Provider info ─────────────────────────────────────────────────────────────

const PROVIDER_META = {
  anthropic: { name: "Claude Sonnet",         model: "claude-sonnet-4-20250514", color: "#cd7f32" },
  openai:    { name: "GPT-4o-mini",           model: "gpt-4o-mini",              color: "#10a37f" },
  google:    { name: "Gemini 1.5 Flash",      model: "gemini-1.5-flash",         color: "#4285f4" },
};

function detectProvider() {
  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced && PROVIDER_META[forced]) {
    const keyMap = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_API_KEY" };
    if (!getKey(keyMap[forced])) {
      throw new Error(`AI_PROVIDER="${forced}" but ${keyMap[forced]} is not set`);
    }
    return forced;
  }
  if (getKey("ANTHROPIC_API_KEY")) return "anthropic";
  if (getKey("OPENAI_API_KEY"))    return "openai";
  if (getKey("GOOGLE_API_KEY"))    return "google";
  return null;
}

export function getProvider()     { try { return detectProvider(); } catch { return null; } }
export function hasProvider()     { return getProvider() !== null; }
export function getProviderName() {
  const p = getProvider();
  return p ? PROVIDER_META[p].name : "No provider configured";
}
export function getProviderMeta() {
  const p = getProvider();
  return p ? { provider: p, ...PROVIDER_META[p] } : null;
}

// Returns masked keys for the settings UI (never expose full keys)
export function getConfiguredKeys() {
  return {
    anthropic: maskKey(getKey("ANTHROPIC_API_KEY")),
    openai:    maskKey(getKey("OPENAI_API_KEY")),
    google:    maskKey(getKey("GOOGLE_API_KEY")),
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
const MAX_RETRIES       = 3;
const BASE_DELAY_MS     = 2000;

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

async function callProvider(provider, prompt) {
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: getKey("ANTHROPIC_API_KEY") });
    return withRetry(async () => {
      const msg = await client.messages.create({
        model: PROVIDER_META.anthropic.model,
        max_tokens: 2000,
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
        max_tokens: 2000,
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
        generationConfig: { responseMimeType: "application/json" },
      });
      const result = await model.generateContent(prompt);
      return result.response.text();
    }, "Google Gemini");
  }

  throw new Error(`Unknown provider: ${provider}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function generateText(prompt) {
  const provider = detectProvider();
  if (!provider) {
    throw new Error(
      "No AI API key configured. Set one in Settings or add to backend/.env:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-...   → https://console.anthropic.com\n" +
      "  OPENAI_API_KEY=sk-...          → https://platform.openai.com/api-keys\n" +
      "  GOOGLE_API_KEY=AIza...         → https://aistudio.google.com/apikey"
    );
  }
  return callProvider(provider, prompt);
}

export function parseJSON(text) {
  const clean = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  return JSON.parse(clean);
}
