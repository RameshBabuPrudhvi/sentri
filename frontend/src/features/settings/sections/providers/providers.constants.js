/**
 * Providers section constants (GAP-002). Extracted verbatim from the legacy
 * Settings.jsx PROVIDERS + OPENAI_COMPAT_HINTS arrays. No React, no JSX —
 * safe to import from any provider sub-component.
 */

export const OPENAI_COMPAT_HINTS = [
  "https://api.deepseek.com/v1",
  "https://api.groq.com/openai/v1",
  "https://api.mistral.ai/v1",
  "https://api.x.ai/v1",
];

export const PROVIDERS = [
  {
    id: "anthropic",
    name: "Claude Sonnet",
    company: "Anthropic",
    model: "claude-sonnet-4-20250514",
    placeholder: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
    color: "#e8965a",
    borderColor: "rgba(205,127,50,0.3)",
    bg: "rgba(205,127,50,0.06)",
    description: "Best quality. Pay-as-you-go from $5 minimum deposit.",
    badge: "Recommended",
    badgeColor: "var(--accent)",
  },
  {
    id: "openai",
    name: "GPT-4o-mini",
    company: "OpenAI",
    model: "gpt-4o-mini",
    placeholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    color: "#3ecfaf",
    borderColor: "rgba(16,163,127,0.3)",
    bg: "rgba(16,163,127,0.06)",
    description: "Fast and affordable. Great for high-volume crawls.",
    badge: "Fast",
    badgeColor: "var(--green)",
  },
  {
    id: "google",
    name: "Gemini 2.5 Flash",
    company: "Google",
    model: "gemini-2.5-flash",
    placeholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    color: "#6ba4f8",
    borderColor: "rgba(66,133,244,0.3)",
    bg: "rgba(66,133,244,0.06)",
    description: "Free tier available (20 req/day limit). Good for testing.",
    badge: "Free tier",
    badgeColor: "var(--purple)",
    warning: "Free tier is limited to 20 requests/day — hits rate limits quickly on large crawls.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    company: "OpenRouter",
    model: "openrouter/auto",
    placeholder: "sk-or-v1-...",
    docsUrl: "https://openrouter.ai/keys",
    color: "#8385f4",
    borderColor: "rgba(100,102,241,0.3)",
    bg: "rgba(100,102,241,0.06)",
    description: "Unified gateway to 200+ models (Claude, GPT, Llama, Mixtral, etc.) with one key.",
    badge: "Multi-model",
    badgeColor: "var(--accent)",
  },
  {
    id: "local",
    name: "Ollama",
    company: "Local / Self-hosted",
    model: "mistral:7b",          // shown as default; overridden by live config
    placeholder: null,            // no API key
    docsUrl: "https://ollama.ai",
    color: "#7c3aed",
    borderColor: "rgba(124,58,237,0.3)",
    bg: "rgba(124,58,237,0.06)",
    description: "100% free, runs on your machine. No data leaves your network.",
    badge: "Private",
    badgeColor: "var(--purple)",
    isLocal: true,
  },
];

/** Provider-icon emoji map. Mirrors the legacy inline ternary in ProviderCard. */
export const PROVIDER_EMOJI = {
  anthropic: "🔶",
  openai:    "🟢",
  openrouter: "🧭",
  local:     "🦙",
  google:    "🔷",
};
