/**
 * journeyGenerator.js — Layer 7: Generate user journey tests (multi-step flows)
 *
 * Thin orchestration layer that delegates to:
 *   - prompts/journeyPrompt.js      — multi-page journey prompt
 *   - prompts/intentPrompt.js       — single-page intent prompt
 *   - prompts/userRequestedPrompt.js — user-described test prompt
 *   - promptHelpers.js              — resolveTestCountInstruction, withDials
 *   - stepSanitiser.js              — sanitiseSteps, extractTestsArray
 */

import { generateText, streamText, parseJSON, isRateLimitError } from "../aiProvider.js";
import { throwIfAborted } from "../utils/abortHelper.js";
import { withDials } from "./promptHelpers.js";
import { extractTestsArray, sanitiseSteps } from "./stepSanitiser.js";
import { buildJourneyPrompt } from "./prompts/journeyPrompt.js";
import { buildIntentPrompt } from "./prompts/intentPrompt.js";
import { buildUserRequestedPrompt } from "./prompts/userRequestedPrompt.js";
import { buildApiTestPrompt } from "./prompts/apiTestPrompt.js";

// ── API intent detection ──────────────────────────────────────────────────────
// Heuristic: if the user's name + description mention API-specific keywords,
// route to the API test prompt instead of the UI test prompt. This lets users
// generate Playwright `request` API tests from the "Generate Test" modal
// without needing a crawl + HAR capture.

const API_INTENT_PATTERNS = [
  /\bAPI\b/,                          // explicit "API"
  /\bREST\b/i,                        // REST API
  /\bGraphQL\b/i,                     // GraphQL
  /\bendpoint/i,                      // "endpoint", "endpoints"
  /\b(GET|POST|PUT|PATCH|DELETE)\s+\//,// "GET /api/users", "POST /login"
  /\bstatus\s*code/i,                 // "status code 200"
  /\brequest\s*body/i,                // "request body"
  /\bresponse\s*(body|shape|schema)/i,// "response body", "response shape"
  /\bjson\s*(response|payload|body)/i,// "JSON response"
  /\bcontract\s*test/i,              // "contract test"
  /\/api\//i,                         // URL path like "/api/users"
];

/**
 * Detect whether the user's test name + description indicate API test intent.
 * @param {string} name
 * @param {string} description
 * @returns {boolean}
 */
function isApiIntent(name, description) {
  const combined = `${name} ${description}`;
  return API_INTENT_PATTERNS.some(re => re.test(combined));
}

/**
 * Parse lightweight endpoint hints from the user's description.
 * Extracts patterns like "GET /api/users", "POST /login" and builds
 * minimal ApiEndpoint-shaped objects for buildApiTestPrompt.
 *
 * @param {string} description
 * @param {string} appUrl
 * @returns {ApiEndpoint[]}
 */
function parseEndpointHints(description, appUrl) {
  const endpoints = [];
  const seen = new Set();

  function addEndpoint(method, pathPattern) {
    const key = `${method} ${pathPattern}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push({
      method,
      pathPattern,
      exampleUrls: [`${appUrl.replace(/\/$/, "")}${pathPattern}`],
      statuses: method === "GET" ? [200] : [200, 201],
      contentType: "application/json",
      requestBodyExample: null,
      responseBodyExample: null,
      callCount: 1,
      avgDurationMs: 0,
      pageUrls: [],
    });
  }

  // 1. Match "METHOD /path" patterns (e.g. "GET /api/users", "POST /api/auth/login")
  const methodPathRe = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/gi;
  let match;
  while ((match = methodPathRe.exec(description)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2].replace(/[.,;:!?)]+$/, "");
    addEndpoint(method, path);
  }

  // 2. Match full URLs containing /api/ (e.g. "https://reqres.in/api/register")
  //    When no METHOD is specified, default to POST for mutation-like paths
  //    (register, login, create, update, delete) and GET for everything else.
  const urlRe = /https?:\/\/[^\s,]+\/api\/[^\s,]*/gi;
  while ((match = urlRe.exec(description)) !== null) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?)]+$/, ""));
      const path = url.pathname;
      const lastSeg = path.split("/").filter(Boolean).pop() || "";
      const isMutation = /register|login|signin|signup|create|update|delete|reset|send|submit/i.test(lastSeg);
      addEndpoint(isMutation ? "POST" : "GET", path);
    } catch { /* invalid URL — skip */ }
  }

  // 3. Match bare /api/ paths not preceded by a METHOD (e.g. "/api/users/:id")
  const barePathRe = /(?<!\w)(\/api\/\S+)/gi;
  while ((match = barePathRe.exec(description)) !== null) {
    const path = match[1].replace(/[.,;:!?)]+$/, "");
    if (!seen.has(`GET ${path}`) && !seen.has(`POST ${path}`)) {
      addEndpoint("GET", path);
    }
  }

  return endpoints;
}

/**
 * generateFromDescription(name, description, appUrl) → Array of test objects
 *
 * Generates test(s) focused on the user's provided name + description.
 * The number of tests is controlled by the `testCount` dial (1–20).
 * Used by the POST /api/projects/:id/tests/generate endpoint instead of the
 * generic generateIntentTests which produces crawl-oriented tests.
 *
 * When the description indicates API test intent (mentions endpoints, HTTP
 * methods, status codes, etc.), automatically routes to the API test prompt
 * which generates Playwright `request` API tests instead of UI tests.
 */
export async function generateFromDescription(name, description, appUrl, onToken, { dialsPrompt = "", testCount = "ai_decides", signal } = {}) {
  const apiIntent = isApiIntent(name, description);

  let prompt;
  if (apiIntent) {
    // Build API test prompt — use parsed endpoint hints from description,
    // or an empty array (the prompt still works, it just uses the name/description
    // as context instead of captured HAR data).
    const endpointHints = parseEndpointHints(description, appUrl);
    const apiPrompt = buildApiTestPrompt(endpointHints, appUrl, { testCount });
    // Inject the user's original name + description so the AI has full context
    // beyond just the parsed endpoint hints (e.g. "write API tests for register
    // endpoint with valid and invalid payloads" gives intent the parser can't capture).
    apiPrompt.user = `USER REQUEST: ${name}\n${description ? `USER DESCRIPTION: ${description}\n\n` : "\n"}${apiPrompt.user}`;
    prompt = withDials(apiPrompt, dialsPrompt);
  } else {
    prompt = withDials(buildUserRequestedPrompt(name, description, appUrl, { testCount }), dialsPrompt);
  }

  const text = onToken
    ? await streamText(prompt, onToken, { signal })
    : await generateText(prompt, { signal });
  const parsed = parseJSON(text);
  const tests = extractTestsArray(parsed);

  // Ensure the test name matches the user's input (AI sometimes renames)
  for (const t of tests) {
    t.sourceUrl = appUrl;
    if (!t.name || t.name === "descriptive name") t.name = name;
    if (apiIntent) {
      t.type = t.type || "integration";
      t._generatedFrom = "api_user_described";
      if (t.name && !t.name.startsWith("API:") && !t.name.startsWith("API ")) {
        t.name = `API: ${t.name}`;
      }
    }
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
    if (isRateLimitError(err)) throw err;
    console.error(`[journeyGenerator] Journey test generation failed: ${err.message?.slice(0, 300)}`);
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
    if (isRateLimitError(err)) throw err;
    console.error(`[journeyGenerator] Intent test generation failed for ${classifiedPage?.url || "unknown"}: ${err.message?.slice(0, 300)}`);
    return [];
  }
}

/**
 * generateAllTests(classifiedPages, journeys, snapshotsByUrl) → { tests, rateLimitHit, rateLimitError }
 *
 * Orchestrates full test generation: journeys first, then per-page intent tests.
 * ALL pages get comprehensive tests — not just high-priority ones.
 *
 * @returns {{ tests: object[], rateLimitHit: boolean, rateLimitError: string|null }}
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
      if (isRateLimitError(err)) {
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

  return {
    tests: allTests,
    rateLimitHit,
    rateLimitError: rateLimitHit ? (rateLimitError?.message || "AI provider rate limit exceeded") : null,
  };
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
    // Propagate rate limit errors so the caller can short-circuit (matches journey/intent generators)
    if (isRateLimitError(err)) throw err;
    console.error(`[journeyGenerator] API test generation failed: ${err.message?.slice(0, 300)}`);
    return [];
  }
}