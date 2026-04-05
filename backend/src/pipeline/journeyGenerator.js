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

  // 1. Generate journey tests (highest value — multi-page flows)
  for (const journey of journeys) {
    throwIfAborted(signal);
    onProgress?.(`🗺️  Generating journey tests: ${journey.name}`);
    const journeyTests = await generateJourneyTest(journey, snapshotsByUrl, { dialsPrompt, testCount, signal });
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

    const tests = await generateIntentTests(classifiedPage, snapshot, { dialsPrompt, testCount, signal });
    for (const t of tests) {
      allTests.push({ ...t, sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
    }
  }

  // 3. Comprehensive tests for ALL remaining pages (NAVIGATION, CONTENT, etc.)
  //    Previously these only got 1 basic test — now they get full 5-8 test coverage
  for (const classifiedPage of classifiedPages) {
    throwIfAborted(signal);
    if (classifiedPage.isHighPriority || coveredUrls.has(classifiedPage.url)) continue;
    const snapshot = snapshotsByUrl[classifiedPage.url];
    if (!snapshot) continue;

    onProgress?.(`📄 Generating tests for: ${classifiedPage.url} [${classifiedPage.dominantIntent}]`);
    const tests = await generateIntentTests(classifiedPage, snapshot, { dialsPrompt, testCount, signal });
    for (const t of tests) {
      allTests.push({ ...t, sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
    }
  }

  return allTests;
}