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
import { streamText, hasProvider, isLocalProvider } from "../aiProvider.js";
import { getDb } from "../db.js";
import { classifyError } from "../utils/errorClassifier.js";

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
 * Build a compact workspace snapshot from the DB for the system prompt.
 * Kept small to avoid wasting tokens — only includes actionable data.
 *
 * @param {Object} db - The database object (from getDb()).
 * @returns {string} Workspace context block, or empty string if no data.
 */
function buildWorkspaceContext(db) {
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
 * Scan the user's message for entity references (TC-*, RUN-*, PRJ-*) and
 * fetch detailed context for each.
 *
 * @param {Object}  db - The database object (from getDb()).
 * @param {string}  userMessage - The latest user message text.
 * @param {Object}  [opts]
 * @param {boolean} [opts.compact=false] - When true, trim heavy fields (code,
 *   errors) to fit local models with small context windows.
 * @returns {string} Detailed entity context block, or empty string.
 */
function buildEntityContext(db, userMessage, { compact = false } = {}) {
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
    const test = db.tests[id];
    if (!test) continue;
    const project = db.projects[test.projectId];
    lines.push(`--- Test Detail: ${id} ---`);
    lines.push(`Name: ${test.name}`);
    lines.push(`Project: ${project?.name || test.projectId} (${project?.url || ""})`);
    lines.push(`Status: ${test.lastResult || "not run"} | Review: ${test.reviewStatus || "draft"}`);
    if (test.description) lines.push(`Description: ${test.description.slice(0, descCap)}`);
    if (test.steps?.length) lines.push(`Steps (${test.steps.length}):\n${test.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
    if (test.playwrightCode) lines.push(`Playwright code:\n\`\`\`javascript\n${test.playwrightCode.slice(0, codeCap)}\n\`\`\``);
    if (test.qualityScore != null) lines.push(`Quality score: ${test.qualityScore}%`);
    if (test.type) lines.push(`Type: ${test.type}`);
    if (test.priority) lines.push(`Priority: ${test.priority}`);

    // Find latest run result for this test
    const latestResult = findLatestTestResult(db, id);
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
    const run = db.runs[id];
    if (!run) continue;
    const project = db.projects[run.projectId];
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
          const test = db.tests[f.testId];
          lines.push(`  - ${test?.name || f.testId}: ${(f.error || "").slice(0, failCap)}`);
        }
      }
    }
    lines.push("");
  }

  // Fetch project details
  for (const id of projectIds.slice(0, maxProjects)) {
    const project = db.projects[id];
    if (!project) continue;
    const pTests = Object.values(db.tests).filter(t => t.projectId === id);
    const pRuns = Object.values(db.runs).filter(r => r.projectId === id);
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
 * @param {Object} db - The database object.
 * @param {string} testId - The test ID to search for.
 * @returns {Object|null} { runId, status, error, duration } or null.
 */
function findLatestTestResult(db, testId) {
  const runs = Object.values(db.runs)
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

  // Build system prompt with live workspace context + deep entity details.
  // Single getDb() call shared by both builders to avoid redundant Object.values().
  const db = getDb();
  const isLocal = isLocalProvider();

  // For local models (Ollama 7B) the combined system+user prompt must fit
  // within a small context window (~4K tokens). Entity context (TC-*, RUN-*)
  // is always included so users can ask about specific tests, but:
  //   - The heavy workspace summary (all projects, runs, pass rate) is skipped
  //   - Entity details use compact mode (shorter code/error caps)
  const workspaceContext = isLocal ? "" : buildWorkspaceContext(db);
  const entityContext = buildEntityContext(db, lastMessage.content, { compact: isLocal });
  const contextParts = [workspaceContext, entityContext].filter(Boolean).join("\n\n");
  const systemPrompt = contextParts
    ? `${BASE_SYSTEM_PROMPT}\n\n${contextParts}`
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

  // Local models have small context windows — cap output tokens so
  // prompt + output don't overflow. Cloud providers handle this natively.
  const streamOpts = { signal, responseFormat: "text" };
  if (isLocal) streamOpts.maxTokens = 2048;

  try {
    await streamText(
      { system: systemPrompt, user: userContent },
      (token) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      },
      streamOpts,
    );

    if (!res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    console.error(`[chat] streamText failed for user ${req.user?.id}: ${err.message}`);
    if (!res.writableEnded) {
      const { message } = classifyError(err, "chat");
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }
});

export default router;
