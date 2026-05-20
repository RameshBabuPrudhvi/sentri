import Anthropic from "@anthropic-ai/sdk";

export async function generate(ctx, deps) {
  const { messages, maxTokens, signal, model } = ctx;
  const { withRetry, composeSignal, CLOUD_TIMEOUT_MS, recordAiTokens } = deps;
  const client = new Anthropic({ apiKey: ctx.apiKey });
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(signal, CLOUD_TIMEOUT_MS);
    try {
      const params = { model, max_tokens: maxTokens, messages: [{ role: "user", content: messages.user }] };
      if (messages.system) params.system = messages.system;
      const msg = await client.messages.create(params, { signal: composedSignal });
      const usage = { input: msg?.usage?.input_tokens, output: msg?.usage?.output_tokens };
      recordAiTokens(ctx.provider, usage);
      return { text: msg.content?.[0]?.text || "", usage };
    } finally { cleanup(); }
  }, "Anthropic");
}

export async function stream(ctx, onToken) {
  const client = new Anthropic({ apiKey: ctx.apiKey });
  const params = { model: ctx.model, max_tokens: ctx.maxTokens, messages: [{ role: "user", content: ctx.messages.user }] };
  if (ctx.messages.system) params.system = ctx.messages.system;
  const stream = client.messages.stream(params, { signal: ctx.signal });
  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta" && chunk.delta?.text) onToken(chunk.delta.text);
  }
  const final = await stream.finalMessage();
  return { text: final?.content?.[0]?.text || "", usage: null };
}

export async function generateVision(ctx) {
  const client = new Anthropic({ apiKey: ctx.apiKey });
  const msg = await client.messages.create({
    model: ctx.model,
    max_tokens: 512,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: ctx.base64 } },
      { type: "text", text: ctx.userPrompt },
    ] }],
  }, { signal: ctx.signal });
  return {
    text: msg.content?.[0]?.text || "",
    usage: { input: msg?.usage?.input_tokens, output: msg?.usage?.output_tokens },
  };
}
