/**
 * OpenAI / OpenRouter / OpenAI-compat adapter — shared SDK, different
 * baseURL + headers. Implements the AI-002 adapter contract:
 *   generate({ messages, maxTokens, signal, useJson, model, apiKey, baseUrl, defaultHeaders, guardedFetch, provider }) → { text, usage }
 *   stream  (same args, plus onToken)                                                                                  → { text, usage }
 *   generateVision({ model, apiKey, baseUrl, defaultHeaders, guardedFetch, dataUrl, userPrompt, signal })               → { text, usage }
 *
 * `provider` is carried through purely for the withRetry log label; it is
 * NOT used to branch behaviour — branching happens via {baseUrl,
 * defaultHeaders, guardedFetch} which are passed in by the orchestrator.
 *
 * `messages` arrives in the spec-standard `{ system, user, combined }` shape;
 * the adapter flattens it to OpenAI's `[{role,content}, ...]` wire shape so
 * callers don't need to know the provider's array convention.
 */
import OpenAI from "openai";
import { withRetry, composeSignal, CLOUD_TIMEOUT_MS } from "../retry.js";
import { throwIfAborted } from "../../utils/abortHelper.js";

function mkClient({ provider, apiKey, baseUrl, defaultHeaders, guardedFetch }) {
  if (provider === "openrouter") {
    return new OpenAI({ apiKey, baseURL: baseUrl, defaultHeaders });
  }
  if (provider?.startsWith("compat:")) {
    return new OpenAI({ apiKey, baseURL: baseUrl, fetch: guardedFetch });
  }
  return new OpenAI({ apiKey });
}

function toOpenAiMessages(messages) {
  const out = [];
  if (messages.system) out.push({ role: "system", content: messages.system });
  out.push({ role: "user", content: messages.user });
  return out;
}

function labelFor(provider) {
  if (provider === "openrouter") return "OpenRouter";
  if (provider?.startsWith("compat:")) return `OpenAI-compat (${provider})`;
  return "OpenAI";
}

export async function generate(opts) {
  const { messages, maxTokens, signal, useJson, model, provider } = opts;
  const client = mkClient(opts);
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(signal, CLOUD_TIMEOUT_MS);
    try {
      const params = { model, max_tokens: maxTokens, messages: toOpenAiMessages(messages) };
      if (useJson) params.response_format = { type: "json_object" };
      const res = await client.chat.completions.create(params, { signal: composedSignal });
      return {
        text: res.choices?.[0]?.message?.content || "",
        usage: { input: res?.usage?.prompt_tokens, output: res?.usage?.completion_tokens },
      };
    } finally { cleanup(); }
  }, labelFor(provider));
}

export async function stream(opts, onToken) {
  const { messages, maxTokens, signal, useJson, model } = opts;
  const client = mkClient(opts);
  const params = { model, max_tokens: maxTokens, stream: true, messages: toOpenAiMessages(messages) };
  if (useJson) params.response_format = { type: "json_object" };
  const s = await client.chat.completions.create(params, { signal });
  let full = "";
  let usage = null;
  for await (const chunk of s) {
    throwIfAborted(signal);
    const token = chunk.choices?.[0]?.delta?.content ?? "";
    if (token) { full += token; onToken(token); }
    if (chunk?.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
  }
  return { text: full, usage };
}

export async function generateVision(opts) {
  const { model, dataUrl, userPrompt, signal } = opts;
  const client = mkClient(opts);
  const res = await client.chat.completions.create({
    model,
    max_tokens: 512,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: [
      { type: "text", text: userPrompt },
      { type: "image_url", image_url: { url: dataUrl } },
    ] }],
  }, { signal });
  return {
    text: res.choices?.[0]?.message?.content || "",
    usage: { input: res?.usage?.prompt_tokens, output: res?.usage?.completion_tokens },
  };
}
