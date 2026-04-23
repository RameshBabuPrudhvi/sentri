/**
 * @module routes/chat
 * @description AI chat endpoint — proxies multi-turn conversations through
 * the configured AI provider (Anthropic / OpenAI / Google / Ollama).
 * Mounted at `/api/v1` (INF-005).
 *
 * The system prompt includes a live workspace snapshot (projects, tests,
 * recent runs, failures) so the AI can answer questions about the user's
 * actual data without extra API calls from the frontend.
 *
 * ### Endpoints
 * | Method | Path            | Description                                   |
 * |--------|-----------------|-----------------------------------------------|
 * | `POST` | `/api/v1/chat`  | Send a message and receive an AI reply (SSE)  |
 *
 * Request body:
 *   { messages: [{ role: "user"|"assistant", content: string }] }
 *
 * Response: Server-Sent Events stream of token deltas, then a `[DONE]` event.
 */

import { Router } from "express";
import { streamText, hasProvider, isLocalProvider } from "../aiProvider.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import { classifyError } from "../utils/errorClassifier.js";
import { formatLogLine, shouldLog } from "../utils/logFormatter.js";
import { MAX_CONVERSATION_TURNS } from "../runner/config.js";
import { runAbortControllers } from "../utils/runWithAbort.js";
import { workerAbortControllers } from "../workers/runWorker.js";

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

You are concise, practical, and always provide working code examples when relevant. When suggesting test improvements, always explain the "why" behind recommendations.

IMPORTANT — Response format rules:
- Always respond in plain text with Markdown formatting (headings, bold, lists, code blocks).
- NEVER wrap your entire response in a JSON object. Do NOT return { "explanation": ..., "fix": ... } or any JSON envelope.
- When showing code, use fenced Markdown code blocks with language tags (e.g. \`\`\`javascript ... \`\`\`).
- When the user asks about their tests, runs, projects, or failures, use the workspace context provided below to give specific, actionable answers.
- If the workspace context is empty or not relevant to the question, answer using your general QA expertise.`;

/**
 * Build a compact workspace snapshot for the system prompt.
 * Kept small to avoid wasting tokens — only includes actionable data.
 *
 * @param {Object} ctx - { projects, tests, runs, projectsById, testsById, runsById }
 * @returns {string} Workspace context block, or empty string if no data.
 */
function buildWorkspaceContext(ctx) {
  const { projects, tests, runs } = ctx;

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
      const proj = ctx.projectsById[r.projectId];
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
        const test = ctx.testsById[result.testId];
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
 * Scan the user's message for entity references (TC-*, RUN-*, PRJ-*) and
 * fetch detailed context for each.
 *
 * @param {Object}  ctx - { projects, tests, runs, projectsById, testsById, runsById }
 * @param {string}  userMessage - The latest user message text.
 * @param {Object}  [opts]
 * @param {boolean} [opts.compact=false] - When true, trim heavy fields (code,
 *   errors) to fit local models with small context windows.
 * @returns {string} Detailed entity context block, or empty string.
 */
function buildEntityContext(ctx, userMessage, { compact = false } = {}) {
  const lines = [];

  // Limits — compact mode keeps context small for Ollama 7B (~4K window)
  const codeCap   = compact ? 500  : 1500;
  const errorCap  = compact ? 200  : 500;
  const descCap   = compact ? 150  : 300;
  const maxTests  = compact ? 2    : 5;
  const maxRuns   = compact ? 1    : 3;
  const maxProjects = compact ? 1  : 3;
  const failCap   = compact ? 150  : 300;

  // Match explicit IDs: TC-1, RUN-42, PRJ-3
  const testIds = [...new Set((userMessage.match(/TC-\d+/gi) || []).map(id => id.toUpperCase()))];
  const runIds = [...new Set((userMessage.match(/RUN-\d+/gi) || []).map(id => id.toUpperCase()))];
  const projectIds = [...new Set((userMessage.match(/PRJ-\d+/gi) || []).map(id => id.toUpperCase()))];

  // Fetch test details
  for (const id of testIds.slice(0, maxTests)) {
    const test = ctx.testsById[id];
    if (!test) continue;
    const project = ctx.projectsById[test.projectId];
    lines.push(`--- Test Detail: ${id} ---`);
    lines.push(`Name: ${test.name}`);
    lines.push(`Project: ${project?.name || test.projectId} (${project?.url || ""})`);
    lines.push(`Status: ${test.lastResult || "not run"} | Review: ${test.reviewStatus || "draft"}`);
    if (test.description) lines.push(`Description: ${test.description.slice(0, descCap)}`);
    if (test.steps?.length) lines.push(`Steps (${test.steps.length}):\n${test.steps.map((s, i) => `  ${i + 1}. ${s.replace(/^\d+\.\s*/, "")}`).join("\n")}`);
    if (test.playwrightCode) lines.push(`Playwright code:\n\`\`\`javascript\n${test.playwrightCode.slice(0, codeCap)}\n\`\`\``);
    if (test.qualityScore != null) lines.push(`Quality score: ${test.qualityScore}%`);
    if (test.type) lines.push(`Type: ${test.type}`);
    if (test.priority) lines.push(`Priority: ${test.priority}`);

    // Find latest run result for this test
    const latestResult = findLatestTestResult(ctx, id);
    if (latestResult) {
      lines.push(`Last run result (${latestResult.runId}):`);
      lines.push(`  Status: ${latestResult.status}`);
      if (latestResult.error) lines.push(`  Error: ${latestResult.error.slice(0, errorCap)}`);
      if (latestResult.duration) lines.push(`  Duration: ${latestResult.duration}ms`);
    }
    lines.push("");
  }

  // Fetch run details
  for (const id of runIds.slice(0, maxRuns)) {
    const run = ctx.runsById[id];
    if (!run) continue;
    const project = ctx.projectsById[run.projectId];
    lines.push(`--- Run Detail: ${id} ---`);
    lines.push(`Type: ${run.type} | Status: ${run.status}`);
    lines.push(`Project: ${project?.name || run.projectId}`);
    if (run.startedAt) lines.push(`Started: ${run.startedAt}`);
    if (run.passed != null) lines.push(`Results: ${run.passed} passed, ${run.failed || 0} failed, ${run.total || 0} total`);
    if (run.duration) lines.push(`Duration: ${run.duration}ms`);

    // Include failed test results with error details
    if (run.results?.length) {
      const failures = run.results.filter(r => r.status === "failed").slice(0, compact ? 3 : 5);
      if (failures.length > 0) {
        lines.push(`Failed tests:`);
        for (const f of failures) {
          const test = ctx.testsById[f.testId];
          lines.push(`  - ${test?.name || f.testId}: ${(f.error || "").slice(0, failCap)}`);
        }
      }
    }
    lines.push("");
  }

  // Fetch project details
  for (const id of projectIds.slice(0, maxProjects)) {
    const project = ctx.projectsById[id];
    if (!project) continue;
    const pTests = ctx.tests.filter(t => t.projectId === id);
    const pRuns = ctx.runs.filter(r => r.projectId === id);
    lines.push(`--- Project Detail: ${id} ---`);
    lines.push(`Name: ${project.name}`);
    lines.push(`URL: ${project.url}`);
    lines.push(`Tests: ${pTests.length} (${pTests.filter(t => t.reviewStatus === "approved").length} approved, ${pTests.filter(t => !t.reviewStatus || t.reviewStatus === "draft").length} draft)`);
    lines.push(`Runs: ${pRuns.length} total`);
    const lastRun = pRuns.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0];
    if (lastRun) {
      lines.push(`Last run: ${lastRun.id} — ${lastRun.status}${lastRun.passed != null ? ` (${lastRun.passed}/${lastRun.total} passed)` : ""}`);
    }
    lines.push("");
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

/**
 * Find the most recent run result for a specific test ID.
 *
 * @param {Object} ctx - { runs }
 * @param {string} testId - The test ID to search for.
 * @returns {Object|null} { runId, status, error, duration } or null.
 */
function findLatestTestResult(ctx, testId) {
  const runs = ctx.runs
    .filter(r => r.results?.length)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

  for (const run of runs) {
    const result = run.results.find(r => r.testId === testId);
    if (result) {
      return {
        runId: run.id,
        status: result.status,
        error: result.error || null,
        duration: result.duration || null,
      };
    }
  }
  return null;
}

// Error classification is handled by the shared classifyError() utility
// in utils/errorClassifier.js — no local classifier needed.

/**
 * Trim a conversation to fit within MAX_CONVERSATION_TURNS.
 *
 * Strategy: keep the first message (initial context) and the most recent
 * turns. Walk forward from the cut point to find a safe boundary at an
 * assistant message — never split a user message from its assistant reply.
 *
 * This is pure truncation — no extra LLM calls. The same single
 * streamText() call is made regardless of whether trimming occurred.
 *
 * @param   {Array<{role: string, content: string}>} messages
 * @returns {Array<{role: string, content: string}>} Trimmed copy (or original if short enough).
 */
function trimConversationHistory(messages) {
  // MAX_CONVERSATION_TURNS * 2 = max individual messages (each turn = user + assistant).
  // +2 accounts for the initial user message and the final user message.
  const maxMessages = MAX_CONVERSATION_TURNS * 2 + 2;
  if (messages.length <= maxMessages) return messages;

  const initial = messages.slice(0, 1); // keep the very first message for context
  let cutIdx = messages.length - MAX_CONVERSATION_TURNS * 2;

  // Walk forward to a safe cut point — an assistant message boundary.
  // This ensures we never split a user message from its assistant reply,
  // which would confuse the LLM about who said what.
  while (cutIdx < messages.length - 2) {
    if (messages[cutIdx].role === "assistant") break;
    cutIdx++;
  }

  const recent = messages.slice(cutIdx);
  return [...initial, ...recent];
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

  // Ollama is single-threaded — concurrent requests cause hangs or crashes.
  // When a crawl/generate/test run is actively making LLM calls via the
  // in-process runner, reject chat requests with a helpful message instead
  // of sending a concurrent request that will hang indefinitely.
  //
  // Known limitation: runAbortControllers and workerAbortControllers track
  // ALL active runs regardless of which AI provider they use. If a run was
  // started with a cloud provider and the user then switches to Ollama in
  // Settings, the cloud run's entry still blocks chat. In practice this is
  // rare (provider switching mid-run) and the conservative false-positive
  // is preferable to letting a concurrent Ollama request hang the model.
  if (isLocalProvider() && (runAbortControllers.size > 0 || workerAbortControllers.size > 0)) {
    return res.status(503).json({
      error: "AI is busy with an active run — Ollama can only process one request at a time. Wait for the run to finish, or abort it first, then try again.",
    });
  }

  const { messages: rawMessages } = req.body;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return res.status(400).json({ error: "messages array is required." });
  }

  // Sliding context window: trim long conversations from the middle so the
  // prompt stays within the LLM's context limit. Zero extra LLM calls —
  // just truncation before the single existing streamText() call.
  const messages = trimConversationHistory(rawMessages);

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

  // Build system prompt with live workspace context + deep entity details.
  // Use lean run queries — chat context only needs scalar fields + results
  // for failure analysis. Skipping logs/testQueue/videoSegments saves ~10-50×
  // in JSON parse time.
  const isLocal = isLocalProvider();
  const projects = projectRepo.getAll(req.workspaceId);
  const projectIds = projects.map((p) => p.id);
  const tests = testRepo.getAllByProjectIds(projectIds);
  const runs = runRepo.getWithResultsByProjectIds(projectIds);
  const projectsById = {};
  for (const p of projects) projectsById[p.id] = p;
  const testsById = {};
  for (const t of tests) testsById[t.id] = t;
  const runsById = {};
  for (const r of runs) runsById[r.id] = r;
  const ctx = { projects, tests, runs, projectsById, testsById, runsById };

  // For local models (Ollama 7B) the combined system+user prompt must fit
  // within a small context window (~4K tokens). Entity context (TC-*, RUN-*)
  // is always included so users can ask about specific tests, but:
  //   - The heavy workspace summary (all projects, runs, pass rate) is skipped
  //   - Entity details use compact mode (shorter code/error caps)
  const workspaceContext = isLocal ? "" : buildWorkspaceContext(ctx);
  const entityContext = buildEntityContext(ctx, lastMessage.content, { compact: isLocal });
  const contextParts = [workspaceContext, entityContext].filter(Boolean).join("\n\n");
  const systemPrompt = contextParts
    ? `${BASE_SYSTEM_PROMPT}\n\n${contextParts}`
    : BASE_SYSTEM_PROMPT;

  // Log prompt metadata at info level (always visible) and full prompt at debug
  const promptCharCount = systemPrompt.length + userContent.length;
  console.log(formatLogLine("info", null, `[chat] provider=${isLocal ? "ollama" : "cloud"} system=${systemPrompt.length} chars user=${userContent.length} chars total=${promptCharCount} chars (~${Math.round(promptCharCount / 4)} tokens) msg="${lastMessage.content.slice(0, 80)}"`));
  if (shouldLog("debug")) {
    console.log(formatLogLine("debug", null, `[chat] === SYSTEM PROMPT ===\n${systemPrompt}\n=== USER CONTENT ===\n${userContent}\n=== END ===`));
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Abort controller: abort on client disconnect OR 120s timeout — whichever
  // comes first. This stops the Ollama call from running after the user closes
  // the chat panel or the browser kills the idle connection.
  // NOTE: Listen on `res.on("close")`, NOT `req.on("close")`. With fetch()-based
  // SSE (ReadableStream), Express emits req "close" immediately after flushHeaders,
  // which would abort the call before Ollama even starts. res "close" fires only
  // when the underlying socket actually disconnects.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  res.on("close", () => {
    if (!res.writableEnded) {
      console.log(formatLogLine("info", null, `[chat] client disconnected mid-stream`));
      controller.abort();
    }
    clearTimeout(timeout);
  });

  // Heartbeat — keeps the SSE connection alive through proxies and browsers
  // while Ollama processes the request (can take 30-120s for local models).
  // Without this, the browser or proxy kills the idle connection before
  // Ollama responds, causing "Failed to fetch" on the frontend.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
    } else {
      clearInterval(heartbeat);
    }
  }, 5000);

  // Local models have small context windows — cap output tokens so
  // prompt + output don't overflow. Cloud providers handle this natively.
  const streamOpts = { signal: controller.signal, responseFormat: "text" };
  if (isLocal) streamOpts.maxTokens = 2048;

  try {
    const startMs = Date.now();
    await streamText(
      { system: systemPrompt, user: userContent },
      (token) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      },
      streamOpts,
    );

    console.log(formatLogLine("info", null, `[chat] completed in ${((Date.now() - startMs) / 1000).toFixed(1)}s`));
    if (!res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    if (err.name === "AbortError" && req.socket?.destroyed) {
      // Client disconnected — nothing to send, just clean up
      console.log(formatLogLine("info", null, `[chat] aborted (client gone)`));
    } else {
      console.error(formatLogLine("error", null, `[chat] streamText failed for user ${req.user?.id}: ${err.message}`));
      if (!res.writableEnded) {
        const { message } = classifyError(err, "chat");
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }
});

export default router;
