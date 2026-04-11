/**
 * @module routes/testFix
 * @description AI-powered test auto-fix from failure context.
 * Mounted at `/api`.
 *
 * ### Endpoints
 * | Method | Path                          | Description                                |
 * |--------|-------------------------------|--------------------------------------------|
 * | `POST` | `/api/tests/:testId/fix`      | Stream an AI-generated fix for a failing test (SSE) |
 * | `POST` | `/api/tests/:testId/apply-fix` | Apply the fixed code to the test record     |
 */

import { Router } from "express";
import * as testRepo from "../database/repositories/testRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import { streamText, hasProvider, isLocalProvider } from "../aiProvider.js";
import { classifyError } from "../utils/errorClassifier.js";
import { logActivity } from "../utils/activityLogger.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { SELF_HEALING_PROMPT_RULES, applyHealingTransforms } from "../selfHealing.js";

const router = Router();

/**
 * Build the system prompt for the test-fix AI call.
 */
const SYSTEM_PROMPT = `You are a Playwright test expert. Your job is to apply a MINIMAL, TARGETED fix to a failing Playwright test.

CRITICAL — MINIMAL CHANGES ONLY:
- Identify the SPECIFIC line(s) that caused the failure based on the error message.
- Fix ONLY those lines. Do NOT rewrite, reorganise, rename, or restyle any other part of the test.
- Every line of the original test that is NOT related to the failure MUST appear UNCHANGED in your output — same indentation, same comments, same helpers, same order.
- If the original code uses safeClick/safeFill/safeExpect, your fix MUST also use them. Do NOT replace self-healing helpers with raw Playwright calls (page.click, page.fill, page.getByRole, etc.).
- If a step comment (// Step N:) exists, keep it exactly as-is.

Rules:
- Start your response with a single line beginning with "FIX: " that summarises in plain English what you changed and why (e.g. "FIX: Step 3 — replaced incorrect button label 'Submit' with 'Sign In' in safeClick."). Keep it under 120 characters.
- After the FIX: line, output a blank line, then the complete fixed Playwright test code — no markdown fences, no other explanation text, no JSON wrapper.
- The code must be a complete, runnable test function starting with \`test('...\` and ending with \`});\`.
- Do NOT include import statements — test/expect are provided externally.
- Add page.waitForLoadState() after navigations.
- If a selector is broken, fix the selector. If a timeout occurs, add appropriate waits. If an assertion fails, fix the assertion to match actual behavior.
- Keep the test name the same as the original.

SELF-HEALING HELPERS — the test runtime provides these helpers. You MUST use them instead of raw Playwright selectors:
${SELF_HEALING_PROMPT_RULES}`;

/**
 * Build the user prompt with test code + failure context.
 */
function buildUserPrompt(test, failureResult, project) {
  const lines = [];

  lines.push("Here is the failing Playwright test:\n");
  lines.push("```javascript");
  lines.push(test.playwrightCode);
  lines.push("```\n");

  if (failureResult) {
    lines.push("Error message:");
    lines.push(failureResult.error || "Unknown error");
    lines.push("");

    if (failureResult.steps?.length) {
      lines.push("Test steps:");
      failureResult.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
      lines.push("");
    }
  }

  if (test.steps?.length) {
    lines.push("Original test steps:");
    test.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
    lines.push("");
  }

  const pageUrl = test.sourceUrl || project?.url || "";
  if (pageUrl) {
    lines.push(`Page URL: ${pageUrl}`);
    lines.push("");
  }

  lines.push("Fix the test so it passes. Make the SMALLEST possible change — only modify the line(s) that caused the failure. Keep every other line identical to the original. Use self-healing helpers (safeClick, safeFill, safeExpect) — not raw Playwright selectors. Start with a FIX: summary line, then a blank line, then the complete fixed code.");

  return lines.join("\n");
}

/**
 * Compute a simple line-based diff summary between two code strings.
 * Returns a compact string showing added/removed lines.
 */
function computeDiffSummary(before, after) {
  const aLines = (before || "").split("\n");
  const bLines = (after || "").split("\n");
  const diff = [];
  let added = 0, removed = 0;

  // Simple LCS-based diff (same algorithm as DiffView.jsx on the frontend)
  const m = aLines.length, n = bLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);

  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      diff.push(`+ ${bLines[j]}`);
      added++;
      j++;
    } else {
      diff.push(`- ${aLines[i]}`);
      removed++;
      i++;
    }
  }

  return { diff: diff.join("\n"), added, removed };
}

// ── POST /api/tests/:testId/fix — SSE stream of AI-generated fix ─────────────

router.post("/tests/:testId/fix", async (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "Test not found" });

  if (!test.playwrightCode) {
    return res.status(400).json({ error: "Test has no Playwright code to fix." });
  }

  if (!hasProvider()) {
    return res.status(503).json({
      error: "No AI provider configured. Go to Settings to add an API key.",
    });
  }

  const project = projectRepo.getById(test.projectId) || null;
  const failureResult = runRepo.findLatestResultForTest(test.id);

  const userPrompt = buildUserPrompt(test, failureResult, project);

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  res.on("close", () => {
    if (!res.writableEnded) {
      console.log(formatLogLine("info", null, `[testFix] client disconnected mid-stream`));
      controller.abort();
    }
    clearTimeout(timeout);
  });

  const streamOpts = { signal: controller.signal, responseFormat: "text" };
  if (isLocalProvider()) streamOpts.maxTokens = 4096;

  let fixedCode = "";
  // Heartbeat is declared here so the finally block can always clear it,
  // even if the try block is never entered (e.g. synchronous throw).
  let heartbeat = null;

  try {
    // Start heartbeat inside try so it's always paired with the finally cleanup
    heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
      } else {
        clearInterval(heartbeat);
      }
    }, 5000);

    const startMs = Date.now();
    await streamText(
      { system: SYSTEM_PROMPT, user: userPrompt },
      (token) => {
        fixedCode += token;
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      },
      streamOpts,
    );

    // Extract the "FIX: ..." explanation line the AI prepends (per system prompt).
    // This must happen BEFORE fence stripping: when the AI outputs
    //   FIX: ...\n\n```js\ncode\n```
    // the opening fence isn't at ^ while the FIX: line is still present, so
    // stripping fences first would leave an orphaned "```javascript" line.
    fixedCode = fixedCode.trim();
    let explanation = null;
    const fixLineMatch = fixedCode.match(/^FIX:\s*(.+?)(?:\n|$)/i);
    if (fixLineMatch) {
      explanation = fixLineMatch[1].trim();
      // Strip the FIX: line (and optional blank line) from the code body
      fixedCode = fixedCode.replace(/^FIX:\s*.+?(?:\n\n?|$)/i, "").trim();
    }

    // Clean the response — strip markdown fences if the model added them.
    // Runs after FIX: extraction so the opening fence is always at ^.
    fixedCode = fixedCode
      .replace(/^```(?:javascript|js|typescript|ts)?\s*\n?/i, "")
      .replace(/\n?\s*```\s*$/i, "")
      .trim();

    // Safety net: rewrite any raw Playwright calls the AI may have used back
    // to self-healing helpers (safeClick, safeFill, safeExpect). This ensures
    // the fixed code stays consistent with the original code style even when
    // the model ignores the self-healing prompt rules.
    fixedCode = applyHealingTransforms(fixedCode);

    // Build diff summary
    const { diff, added, removed } = computeDiffSummary(test.playwrightCode, fixedCode);
    if (!explanation) {
      explanation = `AI applied a fix: ${added} line${added !== 1 ? "s" : ""} added, ${removed} line${removed !== 1 ? "s" : ""} removed. Review the diff below to see exactly what changed.`;
    }

    console.log(formatLogLine("info", null, `[testFix] completed for ${test.id} in ${((Date.now() - startMs) / 1000).toFixed(1)}s — ${added}+ ${removed}-`));

    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true, fixedCode, explanation, diff })}\n\n`);
      res.end();
    }
  } catch (err) {
    if (err.name === "AbortError" && req.socket?.destroyed) {
      console.log(formatLogLine("info", null, `[testFix] aborted (client gone)`));
    } else {
      console.error(formatLogLine("error", null, `[testFix] failed for ${test.id}: ${err.message}`));
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

// ── POST /api/tests/:testId/apply-fix — persist the AI-generated fix ─────────

router.post("/tests/:testId/apply-fix", (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "Test not found" });

  const { code } = req.body;
  if (!code || typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "code is required" });
  }

  // Strip markdown fences in case the AI response was not cleaned upstream
  const sanitizedCode = code.trim()
    .replace(/^```(?:javascript|js|typescript|ts)?\s*\n?/i, "")
    .replace(/\n?\s*```\s*$/i, "")
    .trim();

  // Basic structural validation — must look like a Playwright test function.
  // Accept test(), test.only(), test.skip(), test.fixme(), test.describe(), etc.
  const looksLikeTest = /\btest\s*(\.\s*\w+\s*)?\(/.test(sanitizedCode);
  if (!looksLikeTest || !sanitizedCode.includes("async")) {
    return res.status(400).json({
      error: "Code does not appear to be a valid Playwright test. Must contain a test() call and async.",
    });
  }

  const updates = {};
  if (test.playwrightCode && test.playwrightCode !== sanitizedCode) {
    updates.playwrightCodePrev = test.playwrightCode;
  }

  updates.playwrightCode = sanitizedCode;
  updates.updatedAt = new Date().toISOString();
  updates.aiFixAppliedAt = new Date().toISOString();
  updates.codeVersion = (test.codeVersion || 0) + 1;

  testRepo.update(test.id, updates);

  const project = projectRepo.getById(test.projectId);
  logActivity({
    type: "test.ai_fix",
    projectId: test.projectId,
    projectName: project?.name || null,
    testId: test.id,
    testName: test.name,
    detail: `AI fix applied — code version ${updates.codeVersion}`,
  });

  res.json(testRepo.getById(test.id));
});

export default router;