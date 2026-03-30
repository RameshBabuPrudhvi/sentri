/**
 * journeyGenerator.js — Layer 7: Generate user journey tests (multi-step flows)
 *
 * Instead of isolated "click button" tests, generates flows like:
 *   Login → Dashboard → Action → Logout
 *   Browse → Add to Cart → Checkout
 */

import { generateText, parseJSON } from "../aiProvider.js";
import { SELF_HEALING_PROMPT_RULES } from "../selfHealing.js";

// ── Journey prompt builder ────────────────────────────────────────────────────

function buildJourneyPrompt(journey, allSnapshots) {
  const pageContexts = journey.pages.map(page => {
    const snapshot = allSnapshots[page.url];
    return `
  Page: ${page.url}
  Title: ${page.title}
  Intent: ${page.dominantIntent}
  Key elements: ${JSON.stringify((snapshot?.elements || []).slice(0, 10), null, 2)}`;
  }).join("\n---");

  return `You are a senior QA engineer generating comprehensive Playwright tests for a real user journey.

JOURNEY: ${journey.name}
TYPE: ${journey.type}
DESCRIPTION: ${journey.description}

PAGES IN THIS JOURNEY:
${pageContexts}

Generate 3-5 end-to-end Playwright tests covering this journey from multiple angles.

Requirements:
1. Cover BOTH positive paths (happy paths) AND negative paths (error states, edge cases)
2. Each test must flow through multiple pages/steps logically
3. ${SELF_HEALING_PROMPT_RULES}
4. Include at least 3 meaningful assertions per test — for visibility checks, always use safeExpect as described above; other assertions like toHaveURL(), toContainText(), toHaveValue() may use direct locators.
5. Add page.waitForLoadState() between navigation steps
6. Tests must represent REAL user goals and behaviors
7. Negative tests should verify error messages and validation feedback
8. CRITICAL: Each test's playwrightCode MUST be fully self-contained — it MUST start with await page.goto('FULL_URL') as the very first line inside the test function. Use the actual URL from the PAGE data above.
9. CRITICAL: Do NOT use placeholder URLs like 'https://example.com' — use the real page URL provided.

Return ONLY valid JSON (no markdown):
{
  "tests": [
    {
      "name": "descriptive journey test name",
      "description": "what user goal this validates",
      "priority": "high",
      "type": "${journey.type.toLowerCase()}",
      "scenario": "positive|negative|edge_case",
      "journeyType": "${journey.type}",
      "isJourneyTest": true,
      "steps": ["User opens page", "User performs action", "Assert expected outcome"],
      "playwrightCode": "import { test, expect } from '@playwright/test';\n\ntest('...', async ({ page }) => {\n  // full journey code here\n});"
    }
  ]
}`;
}

// ── Single page intent-based prompt ──────────────────────────────────────────

function buildIntentPrompt(classifiedPage, snapshot) {
  const elements = classifiedPage.classifiedElements
    .filter(({ confidence }) => confidence > 20)
    .slice(0, 20)
    .map(({ element, intent, confidence }) => ({ ...element, intent, confidence }));

  const pageType = classifiedPage.dominantIntent;

  const scenarioHints = {
    AUTH: `Generate 5-8 tests covering:
- POSITIVE: Successful login with valid credentials redirects to dashboard
- POSITIVE: Registration form accepts valid new user data  
- NEGATIVE: Wrong password shows clear error message
- NEGATIVE: Empty required fields show validation errors
- NEGATIVE: Invalid email format blocked before submit
- EDGE: Password visibility toggle works
- EDGE: Forgot password link is accessible`,

    SEARCH: `Generate 5-8 tests covering:
- POSITIVE: Search returns relevant results for valid query
- POSITIVE: Search filters narrow down results correctly
- POSITIVE: Clicking a result navigates to detail page
- NEGATIVE: Empty search query handled gracefully
- NEGATIVE: No results for unknown term shows empty state
- EDGE: Special characters in search don't break the page
- EDGE: Very long search query is handled`,

    CHECKOUT: `Generate 5-8 tests covering:
- POSITIVE: Add item to cart and view cart with correct total
- POSITIVE: Quantity update recalculates cart total
- POSITIVE: Proceed to checkout from cart page
- NEGATIVE: Invalid payment details show error
- NEGATIVE: Empty required checkout fields blocked
- EDGE: Remove item from cart updates totals
- EDGE: Cart persists on page refresh`,

    FORM_SUBMISSION: `Generate 5-8 tests covering:
- POSITIVE: Form submits with all valid required fields
- POSITIVE: Success confirmation is shown after submit
- NEGATIVE: Submit with empty required fields shows validation
- NEGATIVE: Invalid email format shows error before submit
- NEGATIVE: Duplicate submission is prevented
- EDGE: Form scrolls to first error field on failed submit
- EDGE: Character limits enforced on text inputs`,

    NAVIGATION: `Generate 5-8 tests covering:
- POSITIVE: Page title and main heading (H1) are visible and correct
- POSITIVE: Primary navigation links are present and clickable
- POSITIVE: Clicking the logo/brand returns to homepage
- POSITIVE: Key call-to-action buttons are visible and enabled
- POSITIVE: Page loads without console errors (no 404 resources)
- NEGATIVE: 404 URL shows appropriate not-found page
- EDGE: Keyboard navigation reaches all interactive elements
- EDGE: Page is correctly structured with semantic headings`,

    CRUD: `Generate 5-8 tests covering:
- POSITIVE: Create new item with valid data succeeds
- POSITIVE: Created item appears in list immediately  
- POSITIVE: Edit existing item and save persists changes
- NEGATIVE: Create with duplicate name shows error
- NEGATIVE: Required fields block save when empty
- EDGE: Delete shows confirmation dialog
- EDGE: Cancel edit discards unsaved changes`,

    CONTENT: `Generate 5-8 tests covering:
- POSITIVE: Main content/article is visible and readable
- POSITIVE: Images are loaded (no broken images)
- POSITIVE: Internal links within content navigate correctly
- POSITIVE: Page metadata (title, description) is present
- NEGATIVE: Page handles missing optional content gracefully
- EDGE: Long content is paginated or scrollable
- EDGE: Content is accessible with proper heading hierarchy`,
  };

  const hints = scenarioHints[pageType] || scenarioHints.NAVIGATION;

  return `You are a senior QA engineer. Generate comprehensive Playwright tests based on REAL user behavior patterns.

PAGE: ${snapshot.url}
TITLE: ${snapshot.title}
DOMINANT INTENT: ${pageType}
FORMS ON PAGE: ${snapshot.forms}
H1 TEXT: ${snapshot.h1 || "none"}

CLASSIFIED INTERACTIVE ELEMENTS:
${JSON.stringify(elements, null, 2)}

REQUIRED SCENARIO COVERAGE:
${hints}

STRICT RULES:
1. Generate 5-8 tests — must include BOTH positive AND negative scenarios
2. Each test validates a REAL user goal or validates graceful failure handling
3. ${SELF_HEALING_PROMPT_RULES}
4. Every test MUST have at least 2 strong assertions
5. STRONG assertions: toHaveURL(), toBeVisible(), toContainText(), toHaveValue(), toBeEnabled()
6. WEAK (forbidden): toBeTruthy(), toBeDefined(), toEqual(true)
7. Skip tests for: footer, social icons, cookie banners, generic navigation boilerplate
8. Tests must be independent — no shared state between tests
9. For NEGATIVE tests: assert the actual error message or validation indicator is visible
10. Only test elements/behaviors that ACTUALLY exist for this type of page
11. CRITICAL: Every playwrightCode MUST start with: await page.goto('${snapshot.url}', { waitUntil: 'domcontentloaded', timeout: 30000 }); — use the EXACT URL above, never a placeholder
12. CRITICAL: playwrightCode must be fully self-contained and executable on its own

Return ONLY valid JSON (no markdown, no code fences):
{
  "tests": [
    {
      "name": "descriptive name that includes what scenario (positive/negative) is tested",
      "description": "specific user goal or failure scenario being validated",
      "priority": "high|medium",
      "type": "${classifiedPage.dominantIntent.toLowerCase()}",
      "scenario": "positive|negative|edge_case",
      "steps": ["concrete step 1", "concrete step 2", "assert: expected outcome"],
      "playwrightCode": "import { test, expect } from '@playwright/test';\n\ntest('...', async ({ page }) => {\n  // complete test code\n});"
    }
  ]
}`;
}

// ── Two-phase generators ──────────────────────────────────────────────────────
// Phase 1 (PLAN):  Ask the AI for a lightweight test plan — names, scenarios,
//                   and step outlines — without any Playwright code.
// Phase 2 (GENERATE): For each planned test, ask the AI to write the full
//                      Playwright implementation.
//
// Splitting the prompt this way avoids token-limit truncation on large pages
// and gives the AI a focused context window for code generation.
//
// Cost note: Two-phase uses 1 + N calls per page (N = planned tests, typically
// 3-8). For a 10-page site this can mean 70-90 AI calls. We only use two-phase
// when the snapshot is large enough that single-prompt truncation is likely.
// Threshold: if the serialised snapshot elements exceed ~6000 chars, we split.

const TWO_PHASE_THRESHOLD = 6000; // chars of serialised element JSON

function buildPlanPrompt(journey, allSnapshots) {
  const pageContexts = journey.pages.map(page => {
    const snapshot = allSnapshots[page.url];
    return `  Page: ${page.url} | Title: ${page.title} | Intent: ${page.dominantIntent}`;
  }).join("\n");

  return `You are a senior QA engineer. Plan 3-5 end-to-end Playwright tests for this user journey.
Do NOT write any Playwright code yet — only output the test plan.

JOURNEY: ${journey.name}
TYPE: ${journey.type}
DESCRIPTION: ${journey.description}

PAGES:
${pageContexts}

Return ONLY valid JSON (no markdown):
{
  "plan": [
    {
      "name": "descriptive test name",
      "description": "what user goal this validates",
      "scenario": "positive|negative|edge_case",
      "steps": ["Step 1", "Step 2", "Assert: expected outcome"]
    }
  ]
}`;
}

function buildCodePrompt(planned, journey, allSnapshots) {
  const pageContexts = journey.pages.map(page => {
    const snapshot = allSnapshots[page.url];
    return `
  Page: ${page.url}
  Title: ${page.title}
  Intent: ${page.dominantIntent}
  Key elements: ${JSON.stringify((snapshot?.elements || []).slice(0, 10), null, 2)}`;
  }).join("\n---");

  return `You are a senior QA engineer writing a Playwright test.

JOURNEY: ${journey.name}
TEST TO IMPLEMENT:
  Name: ${planned.name}
  Description: ${planned.description}
  Scenario: ${planned.scenario}
  Steps:
${planned.steps.map((s, i) => `    ${i + 1}. ${s}`).join("\n")}

PAGES IN THIS JOURNEY:
${pageContexts}

Requirements:
1. ${SELF_HEALING_PROMPT_RULES}
2. Include at least 3 meaningful assertions per test — for visibility checks, always use safeExpect; other assertions like toHaveURL(), toContainText(), toHaveValue() may use direct locators.
3. Add page.waitForLoadState() between navigation steps
4. CRITICAL: playwrightCode MUST start with await page.goto('FULL_URL') using the real URL above
5. CRITICAL: Do NOT use placeholder URLs like 'https://example.com'

Return ONLY valid JSON (no markdown):
{
  "name": "${planned.name}",
  "description": "${planned.description}",
  "priority": "high",
  "type": "${journey.type.toLowerCase()}",
  "scenario": "${planned.scenario}",
  "journeyType": "${journey.type}",
  "isJourneyTest": true,
  "steps": ${JSON.stringify(planned.steps)},
  "playwrightCode": "import { test, expect } from '@playwright/test';\\n\\ntest('...', async ({ page }) => {\\n  // full test code\\n});"
}`;
}

/**
 * generateJourneyTest(journey, snapshotsByUrl) → array of test objects or []
 *
 * Two-phase: PLAN then GENERATE per test.
 */
export async function generateJourneyTest(journey, snapshotsByUrl) {
  try {
    // ── Phase 1: PLAN ─────────────────────────────────────────────────────
    const planPrompt = buildPlanPrompt(journey, snapshotsByUrl);
    const planText = await generateText(planPrompt, { maxTokens: 4096 });
    const planResult = parseJSON(planText);
    const plan = Array.isArray(planResult.plan) ? planResult.plan
      : Array.isArray(planResult) ? planResult : [];
    if (!plan.length) return [];

    // ── Phase 2: GENERATE code for each planned test ──────────────────────
    const tests = [];
    for (const planned of plan) {
      try {
        const codePrompt = buildCodePrompt(planned, journey, snapshotsByUrl);
        const codeText = await generateText(codePrompt);
        const result = parseJSON(codeText);
        tests.push(result);
      } catch {
        // If code generation fails for one test, keep the plan as a codeless test
        tests.push({
          name: planned.name,
          description: planned.description,
          scenario: planned.scenario,
          steps: planned.steps,
          isJourneyTest: true,
          journeyType: journey.type,
          type: journey.type.toLowerCase(),
          priority: "high",
          playwrightCode: null,
        });
      }
    }
    return tests;
  } catch (err) {
    // Fall back to the single-prompt approach if planning fails
    try {
      const prompt = buildJourneyPrompt(journey, snapshotsByUrl);
      const text = await generateText(prompt);
      const result = parseJSON(text);
      if (Array.isArray(result)) return result;
      if (Array.isArray(result.tests)) return result.tests;
      if (result && result.name) return [result];
      return [];
    } catch {
      return [];
    }
  }
}

// ── Two-phase intent test generator ───────────────────────────────────────────
// Same PLAN → GENERATE split as journey tests, but for single-page intents.
// This avoids token-limit truncation on pages with many elements.

function buildIntentPlanPrompt(classifiedPage, snapshot) {
  const pageType = classifiedPage.dominantIntent;
  return `You are a senior QA engineer. Plan 5-8 Playwright tests for this page.
Do NOT write any Playwright code yet — only output the test plan.

PAGE: ${snapshot.url}
TITLE: ${snapshot.title}
DOMINANT INTENT: ${pageType}
FORMS: ${snapshot.forms}
H1: ${snapshot.h1 || "none"}

Return ONLY valid JSON (no markdown):
{
  "plan": [
    {
      "name": "descriptive test name",
      "description": "what user goal this validates",
      "scenario": "positive|negative|edge_case",
      "steps": ["Step 1", "Step 2", "Assert: expected outcome"]
    }
  ]
}`;
}

function buildIntentCodePrompt(planned, classifiedPage, snapshot) {
  const elements = classifiedPage.classifiedElements
    .filter(({ confidence }) => confidence > 20)
    .slice(0, 20)
    .map(({ element, intent, confidence }) => ({ ...element, intent, confidence }));

  return `You are a senior QA engineer writing a Playwright test.

PAGE: ${snapshot.url}
TITLE: ${snapshot.title}
DOMINANT INTENT: ${classifiedPage.dominantIntent}

TEST TO IMPLEMENT:
  Name: ${planned.name}
  Description: ${planned.description}
  Scenario: ${planned.scenario}
  Steps:
${planned.steps.map((s, i) => `    ${i + 1}. ${s}`).join("\n")}

CLASSIFIED INTERACTIVE ELEMENTS:
${JSON.stringify(elements, null, 2)}

Requirements:
1. ${SELF_HEALING_PROMPT_RULES}
2. Include at least 2 strong assertions (toHaveURL, toBeVisible via safeExpect, toContainText, toHaveValue)
3. Add page.waitForLoadState() after navigation
4. CRITICAL: playwrightCode MUST start with await page.goto('${snapshot.url}', { waitUntil: 'domcontentloaded', timeout: 30000 })
5. CRITICAL: Do NOT use placeholder URLs like 'https://example.com'

Return ONLY valid JSON (no markdown):
{
  "name": "${planned.name}",
  "description": "${planned.description}",
  "priority": "high",
  "type": "${classifiedPage.dominantIntent.toLowerCase()}",
  "scenario": "${planned.scenario}",
  "steps": ${JSON.stringify(planned.steps)},
  "playwrightCode": "import { test, expect } from '@playwright/test';\\n\\ntest('...', async ({ page }) => {\\n  // full test code\\n});"
}`;
}

/**
 * generateIntentTests(classifiedPage, snapshot) → Array of test objects
 *
 * Two-phase: PLAN then GENERATE per test (same as journey tests).
 * Falls back to single-prompt approach if planning fails.
 */
export async function generateIntentTests(classifiedPage, snapshot) {
  // Estimate snapshot size to decide whether two-phase is worth the extra calls.
  // Small pages fit comfortably in a single prompt — no need for 1+N API calls.
  const elementsJSON = JSON.stringify(
    (classifiedPage.classifiedElements || []).slice(0, 20), null, 2
  );
  const useTwoPhase = elementsJSON.length > TWO_PHASE_THRESHOLD;

  if (!useTwoPhase) {
    // ── Single-prompt path (cheap: 1 API call) ────────────────────────────
    try {
      const prompt = buildIntentPrompt(classifiedPage, snapshot);
      const text = await generateText(prompt);
      const parsed = parseJSON(text);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.tests)) return parsed.tests;
      return [];
    } catch {
      return [];
    }
  }

  // ── Two-phase path (expensive: 1 + N API calls) ─────────────────────────
  try {
    // Phase 1: PLAN
    const planPrompt = buildIntentPlanPrompt(classifiedPage, snapshot);
    const planText = await generateText(planPrompt, { maxTokens: 4096 });
    const planResult = parseJSON(planText);
    const plan = Array.isArray(planResult.plan) ? planResult.plan
      : Array.isArray(planResult) ? planResult : [];
    if (!plan.length) return [];

    // Phase 2: GENERATE code for each planned test
    const tests = [];
    for (const planned of plan) {
      try {
        const codePrompt = buildIntentCodePrompt(planned, classifiedPage, snapshot);
        const codeText = await generateText(codePrompt);
        const result = parseJSON(codeText);
        tests.push(result);
      } catch {
        // Code generation failed — keep the plan as a codeless test
        tests.push({
          name: planned.name,
          description: planned.description,
          scenario: planned.scenario,
          steps: planned.steps,
          type: classifiedPage.dominantIntent.toLowerCase(),
          priority: "medium",
          playwrightCode: null,
        });
      }
    }
    return tests;
  } catch {
    // Fall back to single-prompt approach if two-phase planning fails
    try {
      const prompt = buildIntentPrompt(classifiedPage, snapshot);
      const text = await generateText(prompt);
      const parsed = parseJSON(text);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.tests)) return parsed.tests;
      return [];
    } catch {
      return [];
    }
  }
}

/**
 * generateAllTests(classifiedPages, journeys, snapshotsByUrl) → Array of test objects
 *
 * Orchestrates full test generation: journeys first, then per-page intent tests.
 * ALL pages get comprehensive tests — not just high-priority ones.
 */
export async function generateAllTests(classifiedPages, journeys, snapshotsByUrl, onProgress) {
  const allTests = [];

  // 1. Generate journey tests (highest value — multi-page flows)
  for (const journey of journeys) {
    onProgress?.(`🗺️  Generating journey tests: ${journey.name}`);
    const journeyTests = await generateJourneyTest(journey, snapshotsByUrl);
    for (const jt of journeyTests) {
      allTests.push({ ...jt, sourceUrl: journey.pages[0]?.url, pageTitle: journey.name });
    }
  }

  // Track which URLs are fully covered by journeys
  const coveredUrls = new Set(journeys.flatMap(j => j.pages.map(p => p.url)));

  // 2. Comprehensive tests for HIGH-PRIORITY pages not covered by journeys
  for (const classifiedPage of classifiedPages) {
    if (!classifiedPage.isHighPriority) continue;
    if (coveredUrls.has(classifiedPage.url)) continue;

    onProgress?.(`🤖 Generating intent tests for: ${classifiedPage.url} [${classifiedPage.dominantIntent}]`);
    const snapshot = snapshotsByUrl[classifiedPage.url];
    if (!snapshot) continue;

    const tests = await generateIntentTests(classifiedPage, snapshot);
    for (const t of tests) {
      allTests.push({ ...t, sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
    }
  }

  // 3. Comprehensive tests for ALL remaining pages (NAVIGATION, CONTENT, etc.)
  //    Previously these only got 1 basic test — now they get full 5-8 test coverage
  for (const classifiedPage of classifiedPages) {
    if (classifiedPage.isHighPriority || coveredUrls.has(classifiedPage.url)) continue;
    const snapshot = snapshotsByUrl[classifiedPage.url];
    if (!snapshot) continue;

    onProgress?.(`📄 Generating tests for: ${classifiedPage.url} [${classifiedPage.dominantIntent}]`);
    try {
      const tests = await generateIntentTests(classifiedPage, snapshot);
      for (const t of tests) {
        allTests.push({ ...t, sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
      }
    } catch {}
  }

  return allTests;
}
