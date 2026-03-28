import { getPromptForRole } from "./prompts.js";

async function callProvider(systemPrompt, userMessage) {
   const providerName = (process.env.AI_PROVIDER || "openai").toLowerCase();
   console.log("🔥 USING PROVIDER:", providerName);

    if (providerName === "anthropic") {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    return msg.content[0].text;
  }

  if (providerName === "gemini") {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: systemPrompt,
    });
    const result = await model.generateContent(userMessage);
    return result.response.text();
  }

  if (providerName === "openai") {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4000,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });
    return response.choices[0].message.content;
  }

  throw new Error(`Unknown AI_PROVIDER: "${providerName}"`);
}

export async function runAgent(role, input) {
  const systemPrompt = getPromptForRole(role);
  const userMessage = typeof input === "string" ? input : JSON.stringify(input, null, 2);

  console.log(`[Sentri Agent] Running role: ${role} via ${process.env.AI_PROVIDER || "anthropic"}`);

  const raw = await callProvider(systemPrompt, userMessage);
  const cleaned = raw.trim().replace(/^```json\n?/, "").replace(/^```\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(cleaned);
}