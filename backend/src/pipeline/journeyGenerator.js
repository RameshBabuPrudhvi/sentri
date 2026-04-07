/**
 * journeyGenerator.js — Layer 7: Generate user journey tests (multi-step flows)
 *
 * Thin orchestration layer that delegates to:
 *   - prompts/journeyPrompt.js      — multi-page journey prompt
 *   - prompts/intentPrompt.js       — single-page intent prompt
 *   - prompts/userRequestedPrompt.js — user-requested test prompt
 *   - promptHelpers.js              — resolveTestCountInstruction, withDials
 *   - stepSanitiser.js              — sanitiseSteps, extractTestsArray
 */

import { generateText, streamText, parseJSON } from "../aiProvider.js";
import { throwIfAborted } from "../utils/abortHelper.js";
import { withDials } from "./promptHelpers.js";
import { extractTestsArray, sanitiseSteps } from "./stepSanitiser.js";
import { buildJourneyPrompt } from "./prompts/journeyPrompt.js";
import { buildIntentPrompt } from "./prompts/intentPrompt.js";
import { buildUserRequestedPrompt } from "./prompts/userRequestedPrompt.js";
import { buildApiTestPrompt } from "./prompts/apiTestPrompt.js";

/**
 * Detect whether an error is a rate limit / quota exhaustion from any provider.
 * Used to propagate these errors instead of silently returning [].
 */
function isRateLimitLike(err) {
  const msg = (err?.message || "").toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  if (status === 429) return true;
  // Use word-boundary-aware patterns to avoid false positives on port
  // numbers (e.g. "localhost:4290"), disk quota errors, etc.
  return /\brate.?limit/i.test(msg)
    || /\brate_limit/i.test(msg)
    || /\b429\b/.test(msg)
    || /\bquota\s*(exceeded|exhausted|limit)/i.test(msg)
    || /\btoo many requests\b/i.test(msg)
    || /\bresource.?exhausted\b/i.test(msg);
}

/**
 * generateUserRequestedTest(name, description, appUrl) → Array of test objects
 *
 * Generates exactly ONE test focused on the user's provided name + description.
 * Used by the POST /api/projects/:id/tests/generate endpoint instead of the
 * generic generateIntentTests which produces 5-8 crawl-oriented tests.
 */
export async function generateUserRequestedTest(name, description, appUrl, onToken, { dialsPrompt = "", testCount = "ai_decides", signal } = {}) {
  const prompt = withDials(buildUserRequestedPrompt(name, description, appUrl, { testCount }), dialsPrompt);
  const text = onToken
    ? await streamText(prompt, onToken, { signal })
    : await generateText(prompt, { signal });
  const parsed = parseJSON(text);
  const tests = extractTestsArray(parsed);

  // Ensure the test name matches the user's input (AI sometimes renames)
  for (const t of tests) {
    t.sourceUrl = appUrl;
    if (!t.name || t.name === "descriptive name") t.name = name;
  }

  // Convert Playwright code steps to human-readable descriptions (Mistral/small LLMs)
  sanitiseSteps(tests);

  return tests;
}

// ── Main generators ───────────────────────────────────────────────────────────

/**
 * generateJourneyTest(journey, snapshotsByUrl) → array of test objects or []
 */
export async function generateJourneyTest(journey, snapshotsByUrl, { dialsPrompt = "", testCount = "ai_decides", signal } = {}) {
  try {
    const prompt = withDials(buildJourneyPrompt(journey, snapshotsByUrl, { testCount }), dialsPrompt);
    const text = await generateText(prompt, { signal });
    const result = parseJSON(text);
    const tests = extractTestsArray(result);
    if (tests.length === 0) return [];

    sanitiseSteps(tests);
    return tests;
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    // Propagate rate limit errors so the caller can short-circuit
    if (isRateLimitLike(err)) throw err;
    return [];
  }
}

/**
 * generateIntentTests(classifiedPage, snapshot) → Array of test objects
 */
export async function generateIntentTests(classifiedPage, snapshot, { dialsPrompt = "", testCount = "ai_decides", signal } = {}) {
  try {
    const prompt = withDials(buildIntentPrompt(classifiedPage, snapshot, { testCount }), dialsPrompt);
    const text = await generateText(prompt, { signal });
    const parsed = parseJSON(text);
    const tests = extractTestsArray(parsed);
    if (tests.length === 0) return [];

    sanitiseSteps(tests);
    return tests;
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    // Propagate rate limit errors so the caller can short-circuit
    if (isRateLimitLike(err)) throw err;
    return [];
  }
}

/**
 * generateAllTests(classifiedPages, journeys, snapshotsByUrl) → Array of test objects
 *
 * Orchestrates full test generation: journeys first, then per-page intent tests.
 * ALL pages get comprehensive tests — not just high-priority ones.
 */
export async function generateAllTests(classifiedPages, journeys, snapshotsByUrl, onProgress, { dialsPrompt = "", testCount = "ai_decides", signal } = {}) {
  const allTests = [];
  let rateLimitHit = false;
  let rateLimitError = null;

  // Helper: call a generator and handle rate limit short-circuit
  async function safeGenerate(label, fn) {
    if (rateLimitHit) return []; // skip remaining calls after rate limit
    try {
      return await fn();
    } catch (err) {
      if (err.name === "AbortError" || signal?.aborted) throw err;
      if (isRateLimitLike(err)) {
        rateLimitHit = true;
        rateLimitError = err;
        onProgress?.(`⚠️  AI rate limit reached: ${err.message.slice(0, 120)}`);
        onProgress?.(`⏭️  Skipping remaining AI calls — ${allTests.length} tests generated so far`);
        return [];
      }
      onProgress?.(`⚠️  ${label} failed: ${err.message.slice(0, 100)}`);
      return [];
    }
  }

  // 1. Generate journey tests (highest value — multi-page flows)
  for (const journey of journeys) {
    throwIfAborted(signal);
    onProgress?.(`🗺️  Generating journey tests: ${journey.name}`);
    const journeyTests = await safeGenerate(`Journey "${journey.name}"`, () =>
      generateJourneyTest(journey, snapshotsByUrl, { dialsPrompt, testCount, signal })
    );
    for (const jt of journeyTests) {
      allTests.push({ ...jt, sourceUrl: journey.pages[0]?.url, pageTitle: journey.name });
    }
  }

  // Track which URLs are fully covered by journeys
  const coveredUrls = new Set(journeys.flatMap(j => j.pages.map(p => p.url)));

  // 2. Comprehensive tests for HIGH-PRIORITY pages not covered by journeys
  for (const classifiedPage of classifiedPages) {
    throwIfAborted(signal);
    if (!classifiedPage.isHighPriority) continue;
    if (coveredUrls.has(classifiedPage.url)) continue;

    onProgress?.(`🤖 Generating intent tests for: ${classifiedPage.url} [${classifiedPage.dominantIntent}]`);
    const snapshot = snapshotsByUrl[classifiedPage.url];
    if (!snapshot) continue;

    const tests = await safeGenerate(`Intent tests for ${classifiedPage.url}`, () =>
      generateIntentTests(classifiedPage, snapshot, { dialsPrompt, testCount, signal })
    );
    for (const t of tests) {
      allTests.push({ ...t, sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
    }
  }

  // 3. Comprehensive tests for ALL remaining pages (NAVIGATION, CONTENT, etc.)
  for (const classifiedPage of classifiedPages) {
    throwIfAborted(signal);
    if (classifiedPage.isHighPriority || coveredUrls.has(classifiedPage.url)) continue;
    const snapshot = snapshotsByUrl[classifiedPage.url];
    if (!snapshot) continue;

    onProgress?.(`📄 Generating tests for: ${classifiedPage.url} [${classifiedPage.dominantIntent}]`);
    const tests = await safeGenerate(`Tests for ${classifiedPage.url}`, () =>
      generateIntentTests(classifiedPage, snapshot, { dialsPrompt, testCount, signal })
    );
    for (const t of tests) {
      allTests.push({ ...t, sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
    }
  }

  // Attach rate limit info so the caller can surface it in the run record
  if (rateLimitHit) {
    allTests._rateLimitHit = true;
    allTests._rateLimitError = rateLimitError?.message || "AI provider rate limit exceeded";
  }

  return allTests;
}

// ── API test generation ───────────────────────────────────────────────────────

/**
 * generateApiTests(apiEndpoints, appUrl, opts) → Array of test objects
 *
 * Generates Playwright `request` API tests from HAR-captured endpoint summaries.
 * Returns an empty array if no endpoints were captured or the AI call fails.
 *
 * @param {ApiEndpoint[]} apiEndpoints — from summariseApiEndpoints()
 * @param {string}        appUrl       — project base URL
 * @param {object}        [opts]
 * @param {string}        [opts.dialsPrompt]
 * @param {string}        [opts.testCount]
 * @param {AbortSignal}   [opts.signal]
 * @returns {Promise<object[]>}
 */
export async function generateApiTests(apiEndpoints, appUrl, { dialsPrompt = "", testCount = "ai_decides", signal } = {}) {
  if (!apiEndpoints || apiEndpoints.length === 0) return [];

  try {
    throwIfAborted(signal);
    const prompt = withDials(buildApiTestPrompt(apiEndpoints, appUrl, { testCount }), dialsPrompt);
    const text = await generateText(prompt, { signal });
    const parsed = parseJSON(text);
    const tests = extractTestsArray(parsed);
    if (tests.length === 0) return [];

    // Mark all API tests with the correct type and source
    for (const t of tests) {
      t.type = t.type || "integration";
      t.sourceUrl = appUrl;
      t._generatedFrom = "api_har_capture";
      // Prefix name with "API:" if not already
      if (t.name && !t.name.startsWith("API:") && !t.name.startsWith("API ")) {
        t.name = `API: ${t.name}`;
      }
    }

    sanitiseSteps(tests);
    return tests;
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    return [];
  }
}