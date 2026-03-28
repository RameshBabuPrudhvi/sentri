/**
 * Sentri — Multi-Provider AI Client
 *
 * Supports: OpenAI (gpt-4o-mini), Anthropic (claude-sonnet), Google (gemini-2.0-flash)
 *
 * Set ONE of these in your .env:
 *   OPENAI_API_KEY=sk-...
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   GOOGLE_API_KEY=AIza...
 *
 * Optionally force a specific provider:
 *   AI_PROVIDER=openai | anthropic | google
 *
 * If AI_PROVIDER is not set, the first key found is used automatically.
 */

// ── Detect which provider to use ─────────────────────────────────────────────

function detectProvider() {
  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced) return forced;
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GOOGLE_API_KEY)    return "google";
  return null;
}

export const AI_PROVIDER = detectProvider();

// ── Validate on startup ───────────────────────────────────────────────────────

export function validateAIConfig() {
  if (!AI_PROVIDER) {
    throw new Error(
      "No AI provider configured. Set one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY in your .env file."
    );
  }
  const keyMap = {
    openai:    "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google:    "GOOGLE_API_KEY",
  };
  const required = keyMap[AI_PROVIDER];
  if (!required) throw new Error(`Unknown AI_PROVIDER "${AI_PROVIDER}". Use: openai, anthropic, or google.`);
  if (!process.env[required]) throw new Error(`AI_PROVIDER is "${AI_PROVIDER}" but ${required} is not set.`);
  return AI_PROVIDER;
}

// ── Model names ───────────────────────────────────────────────────────────────

const MODELS = {
  openai:    process.env.OPENAI_MODEL    || "gpt-4o-mini",
  anthropic: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
  google:    process.env.GOOGLE_MODEL    || "gemini-2.0-flash",
};

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function callOpenAI(prompt) {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: MODELS.openai,
    max_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0].message.content;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function callAnthropic(prompt) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODELS.anthropic,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });
  // Strip markdown fences if model wraps JSON
  return res.content[0].text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
}

// ── Google Gemini ─────────────────────────────────────────────────────────────

async function callGoogle(prompt) {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  const res = await client.models.generateContent({
    model: MODELS.google,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      maxOutputTokens: 2000,
    },
  });
  return res.text;
}

// ── Unified call ──────────────────────────────────────────────────────────────

export async function callAI(prompt) {
  let raw;
  switch (AI_PROVIDER) {
    case "openai":    raw = await callOpenAI(prompt);    break;
    case "anthropic": raw = await callAnthropic(prompt); break;
    case "google":    raw = await callGoogle(prompt);    break;
    default: throw new Error(`Unknown provider: ${AI_PROVIDER}`);
  }

  // Parse and normalise the response into an array of tests
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed))                      return parsed;
  if (Array.isArray(parsed.tests))                return parsed.tests;
  if (Array.isArray(parsed.testCases))            return parsed.testCases;
  if (Array.isArray(parsed.test_cases))           return parsed.test_cases;
  const first = Object.values(parsed).find(v => Array.isArray(v));
  return first || [];
}
