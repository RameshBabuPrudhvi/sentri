import OpenAI from "openai";

function mkClient(ctx) {
  if (ctx.provider === "openrouter") {
    return new OpenAI({ apiKey: ctx.apiKey, baseURL: ctx.baseUrl, defaultHeaders: ctx.defaultHeaders });
  }
  if (ctx.provider?.startsWith("compat:")) {
    return new OpenAI({ apiKey: ctx.apiKey, baseURL: ctx.baseUrl, fetch: ctx.guardedFetch });
  }
  return new OpenAI({ apiKey: ctx.apiKey });
}

export async function generate(ctx, deps) {
  const client = mkClient(ctx);
  const { withRetry, composeSignal, CLOUD_TIMEOUT_MS, recordAiTokens } = deps;
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(ctx.signal, CLOUD_TIMEOUT_MS);
    try {
      const params = { model: ctx.model, max_tokens: ctx.maxTokens, messages: ctx.openAiMessages };
      if (ctx.useJson) params.response_format = { type: "json_object" };
      const res = await client.chat.completions.create(params, { signal: composedSignal });
      const usage = { input: res?.usage?.prompt_tokens, output: res?.usage?.completion_tokens };
      recordAiTokens(ctx.provider, usage);
      return { text: res.choices?.[0]?.message?.content || "", usage };
    } finally { cleanup(); }
  }, ctx.provider === "openrouter" ? "OpenRouter" : (ctx.provider?.startsWith("compat:") ? `OpenAI-compat (${ctx.provider})` : "OpenAI"));
}

export async function stream(ctx, onToken) {
  const client = mkClient(ctx);
  const params = { model: ctx.model, max_tokens: ctx.maxTokens, stream: true, messages: ctx.openAiMessages };
  if (ctx.useJson) params.response_format = { type: "json_object" };
  const stream = await client.chat.completions.create(params, { signal: ctx.signal });
  let full = "";
  for await (const chunk of stream) {
    const token = chunk.choices?.[0]?.delta?.content ?? "";
    if (token) { full += token; onToken(token); }
  }
  return { text: full, usage: null };
}

export async function generateVision(ctx) {
  const client = mkClient(ctx);
  const res = await client.chat.completions.create({
    model: ctx.model,
    max_tokens: 512,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: [{ type: "text", text: ctx.userPrompt }, { type: "image_url", image_url: { url: ctx.dataUrl } }] }],
  }, { signal: ctx.signal });
  return { text: res.choices?.[0]?.message?.content || "", usage: { input: res?.usage?.prompt_tokens, output: res?.usage?.completion_tokens } };
}
