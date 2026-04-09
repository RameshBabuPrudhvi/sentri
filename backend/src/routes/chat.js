/**
 * @module routes/chat
 * @description Streaming chat endpoint for the assistant panel.
 */

import { Router } from "express";
import { streamText } from "../aiProvider.js";

const router = Router();

const SYSTEM_PROMPT = [
  "You are Sentri Assistant, a concise QA automation copilot.",
  "Help users with test strategy, bug triage, and product quality workflows.",
  "When uncertain, say what you are assuming.",
].join(" ");

router.post("/chat", async (req, res) => {
  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }

  const sanitized = messages
    .filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .filter((m) => m.content.length > 0);

  if (sanitized.length === 0) {
    return res.status(400).json({ error: "No valid chat messages found" });
  }

  const transcript = sanitized
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    await streamText(
      {
        system: SYSTEM_PROMPT,
        user: transcript,
      },
      (token) => {
        res.write(`data: ${JSON.stringify({ token })}\n\n`);
      },
    );

    res.write("data: [DONE]\n\n");
    return res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat failed";
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }
});

export default router;
