/**
 * @module routes/chat
 * @description AI chat endpoint — proxies multi-turn conversations through
 * the configured AI provider (Anthropic / OpenAI / Google / Ollama).
 * Mounted at `/api`.
 *
 * ### Endpoints
 * | Method | Path        | Description                                   |
 * |--------|-------------|-----------------------------------------------|
 * | `POST` | `/api/chat` | Send a message and receive an AI reply (SSE)  |
 *
 * Request body:
 *   { messages: [{ role: "user"|"assistant", content: string }] }
 *
 * Response: Server-Sent Events stream of token deltas, then a `[DONE]` event.
 */

import { Router } from "express";
import { streamText, hasProvider } from "../aiProvider.js";

const router = Router();

const SYSTEM_PROMPT = `You are Sentri AI, an expert QA engineering assistant built into the Sentri testing platform. You help teams write better tests, debug failures, analyze test results, and improve overall test coverage and quality.

Your expertise includes:
- Automated testing (Playwright, Selenium, Cypress, Puppeteer)
- API testing (REST, GraphQL, gRPC)
- Test strategy and architecture
- CI/CD integration and test pipelines
- Performance and load testing
- Security testing
- Debugging flaky tests and test failures
- Test data management
- Code review for test quality

You are concise, practical, and always provide working code examples when relevant. Format code in markdown code blocks with proper language tags. When suggesting test improvements, always explain the "why" behind recommendations.`;

/**
 * POST /api/chat
 *
 * Accepts a messages array and streams the AI reply token-by-token via SSE.
 * Only the last user message is sent as the "user" turn; prior turns are
 * prepended to the system prompt as conversation context.
 *
 * Body: { messages: Array<{ role: "user"|"assistant", content: string }> }
 */
router.post("/chat", async (req, res) => {
  if (!hasProvider()) {
    return res.status(503).json({
      error: "No AI provider configured. Go to Settings to add an API key.",
    });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required." });
  }

  // Build the user prompt — include conversation history as context
  const history = messages
    .slice(0, -1)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "user") {
    return res.status(400).json({ error: "Last message must be from the user." });
  }

  const userContent = history
    ? `Previous conversation:\n${history}\n\nUser: ${lastMessage.content}`
    : lastMessage.content;

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const signal = req.socket.destroyed
    ? AbortSignal.abort()
    : AbortSignal.timeout(120_000);

  try {
    await streamText(
      { system: SYSTEM_PROMPT, user: userContent },
      (token) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      },
      { signal }
    );

    if (!res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    console.error(`[chat] streamText failed for user ${req.user?.id}: ${err.message}`);
    if (!res.writableEnded) {
      const message = err.name === "TimeoutError"
        ? "Request timed out. Please try again."
        : "An unexpected error occurred. Please try again.";
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }
});

export default router;
