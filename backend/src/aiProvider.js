// backend/src/aiProvider.js

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(snapshot, projectUrl) {
  return `You are an expert QA engineer. Given this page snapshot from a web application, generate 2-4 specific, actionable Playwright test cases.

Page snapshot:
- URL: ${snapshot.url}
- Title: ${snapshot.title}
- H1: ${snapshot.h1}
- Forms on page: ${snapshot.forms}
- Interactive elements: ${JSON.stringify(snapshot.elements, null, 2)}

Generate test cases as a JSON array. Each test case must have:
- "name": short descriptive test name
- "description": what this test validates
- "priority": "high" | "medium" | "low"
- "type": "navigation" | "form" | "visibility" | "interaction"
- "steps": array of plain-English steps
- "playwrightCode": complete runnable Playwright test code using page object, targeting this URL: ${snapshot.url}

Focus on: page loads correctly, key elements visible, forms functional, navigation works.
Return ONLY a valid JSON array. No markdown fences, no explanation, no extra text.`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseResponse(raw) {
  try {
    const cleaned = raw.trim().replace(/^```json\n?/, "").replace(/^```\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Providers ────────────────────────────────────────────────────────────────

async function runAnthropic(prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content[0].text;
}

async function runGemini(prompt) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function runOpenAI(prompt) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0].message.content;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

const PROVIDERS = {
  anthropic: runAnthropic,
  gemini: runGemini,
  openai: runOpenAI,
};

export async function generateTests(snapshot, projectUrl) {
  const providerName = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
  const providerFn = PROVIDERS[providerName];

  if (!providerFn) {
    throw new Error(
      `Unknown AI_PROVIDER: "${providerName}". Valid options: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }

  const prompt = buildPrompt(snapshot, projectUrl);
  const raw = await providerFn(prompt);
  return parseResponse(raw);
}