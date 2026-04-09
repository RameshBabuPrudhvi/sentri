/**
 * @module routes/chat
 * @description AI chat endpoint — proxies multi-turn conversations through
 * the configured AI provider (Anthropic / OpenAI / Google / Ollama).
 * Mounted at `/api`.
 *
 * The system prompt includes a live workspace snapshot (projects, tests,
 * recent runs, failures) so the AI can answer questions about the user's
 * actual data without extra API calls from the frontend.
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
import { getDb } from "../db.js";

const router = Router();

const BASE_SYSTEM_PROMPT = `You are Sentri AI, an expert QA engineering assistant built into the Sentri testing platform. You help teams write better tests, debug failures, analyze test results, and improve overall test coverage and quality.

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

You are concise, practical, and always provide working code examples when relevant. Format code in markdown code blocks with proper language tags. When suggesting test improvements, always explain the "why" behind recommendations.

When the user asks about their tests, runs, projects, or failures, use the workspace context provided below to give specific, actionable answers. If the workspace context is empty or not relevant to the question, answer using your general QA expertise.`;

/**
 * Build a compact workspace snapshot from the DB for the system prompt.
 * Kept small to avoid wasting tokens — only includes actionable data.
 *
 * @returns {string} Workspace context block, or empty string if no data.
 */
function buildWorkspaceContext() {
  const db = getDb();
  const projects = Object.values(db.projects);
  const tests = Object.values(db.tests);
  const runs = Object.values(db.runs);

  if (projects.length === 0) return "";

  const lines = ["--- Current Workspace ---"];

  // Projects summary
  lines.push(`Projects (${projects.length}):`);
  for (const p of projects.slice(0, 10)) {
    const pTests = tests.filter(t => t.projectId === p.id);
    const approved = pTests.filter(t => t.reviewStatus === "approved").length;
    const draft = pTests.filter(t => !t.reviewStatus || t.reviewStatus === "draft").length;
    lines.push(`  - ${p.name} (${p.url}) — ${pTests.length} tests (${approved} approved, ${draft} draft)`);
  }

  // Test review summary
  const totalDraft = tests.filter(t => !t.reviewStatus || t.reviewStatus === "draft").length;
  const totalApproved = tests.filter(t => t.reviewStatus === "approved").length;
  const totalRejected = tests.filter(t => t.reviewStatus === "rejected").length;
  lines.push(`\nTest review: ${tests.length} total — ${totalApproved} approved, ${totalDraft} draft, ${totalRejected} rejected`);

  // Recent runs (last 5)
  const recentRuns = runs
    .filter(r => r.startedAt)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 5);

  if (recentRuns.length > 0) {
    lines.push(`\nRecent runs:`);
    for (const r of recentRuns) {
      const proj = db.projects[r.projectId];
      const pName = proj?.name || r.projectId;
      const status = r.status || "unknown";
      const results = r.passed != null ? ` — ${r.passed} passed, ${r.failed || 0} failed` : "";
      lines.push(`  - ${r.id} [${r.type}] ${pName}: ${status}${results}`);
    }
  }

  // Failing tests (last run results)
  const failingTests = [];
  const latestTestRuns = runs
    .filter(r => (r.type === "test_run" || r.type === "run") && r.results?.length)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 3);

  for (const r of latestTestRuns) {
    for (const result of r.results) {
      if (result.status === "failed" && failingTests.length < 10) {
        const test = db.tests[result.testId];
        failingTests.push({
          name: test?.name || result.testId,
          error: (result.error || "").slice(0, 200),
          runId: r.id,
        });
      }
    }
  }

  if (failingTests.length > 0) {
    lines.push(`\nFailing tests:`);
    for (const f of failingTests) {
      lines.push(`  - "${f.name}" (${f.runId}): ${f.error}`);
    }
  }

  // Pass rate
  const completedRuns = runs
    .filter(r => (r.type === "test_run" || r.type === "run") && r.status === "completed" && r.total > 0)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 10);

  if (completedRuns.length > 0) {
    const totalPassed = completedRuns.reduce((s, r) => s + (r.passed || 0), 0);
    const totalTests = completedRuns.reduce((s, r) => s + (r.total || 0), 0);
    const passRate = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : null;
    if (passRate != null) {
      lines.push(`\nOverall pass rate (last ${completedRuns.length} runs): ${passRate}%`);
    }
  }

  return lines.join("\n");
}

/**
 * POST /api/chat
 *
 * Accepts a messages array and streams the AI reply token-by-token via SSE.
 * Only the last user message is sent as the "user" turn; prior turns are
 * prepended to the system prompt as conversation context.
 *
 * The system prompt is enriched with a live workspace snapshot so the AI
 * can reference the user's actual projects, tests, runs, and failures.
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

  // Build system prompt with live workspace context
  const workspaceContext = buildWorkspaceContext();
  const systemPrompt = workspaceContext
    ? `${BASE_SYSTEM_PROMPT}\n\n${workspaceContext}`
    : BASE_SYSTEM_PROMPT;

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
      { system: systemPrompt, user: userContent },
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
