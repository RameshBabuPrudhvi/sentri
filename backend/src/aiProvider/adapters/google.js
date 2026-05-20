import { GoogleGenerativeAI } from "@google/generative-ai";

export async function generate(ctx, deps) {
  const genAI = new GoogleGenerativeAI(ctx.apiKey);
  const { withRetry, composeSignal, CLOUD_TIMEOUT_MS, recordAiTokens } = deps;
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(ctx.signal, CLOUD_TIMEOUT_MS);
    try {
      const generationConfig = { maxOutputTokens: ctx.maxTokens };
      if (ctx.useJson) generationConfig.responseMimeType = "application/json";
      const cfg = { model: ctx.model, generationConfig };
      if (ctx.messages.system) cfg.systemInstruction = { parts: [{ text: ctx.messages.system }] };
      const m = genAI.getGenerativeModel(cfg);
      const result = await m.generateContent({ contents: [{ role: "user", parts: [{ text: ctx.messages.user }] }] }, { signal: composedSignal });
      const um = result?.response?.usageMetadata;
      const usage = { input: um?.promptTokenCount, output: um?.candidatesTokenCount };
      recordAiTokens(ctx.provider, usage);
      return { text: result.response.text(), usage };
    } finally { cleanup(); }
  }, "Google Gemini");
}

export async function stream() { return null; }

export async function generateVision(ctx) {
  const genAI = new GoogleGenerativeAI(ctx.apiKey);
  const m = genAI.getGenerativeModel({ model: ctx.model, generationConfig: { maxOutputTokens: 512, responseMimeType: "application/json" } });
  const result = await m.generateContent({ contents: [{ role: "user", parts: [{ text: ctx.userPrompt }, { inlineData: { mimeType: "image/png", data: ctx.base64 } }] }] });
  const um = result?.response?.usageMetadata;
  return { text: result.response.text(), usage: { input: um?.promptTokenCount, output: um?.candidatesTokenCount } };
}
