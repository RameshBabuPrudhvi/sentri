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

// ── Main generators ───────────────────────────────────────────────────────────

/**
 * generateJourneyTest(journey, snapshotsByUrl) → array of test objects or []
 */
export async function generateJourneyTest(journey, snapshotsByUrl) {
  try {
    const prompt = buildJourneyPrompt(journey, snapshotsByUrl);
    const text = await generateText(prompt);
    const result = parseJSON(text);

    if (Array.isArray(result)) return result;
    if (Array.isArray(result.tests)) return result.tests;
    if (result && result.name) return [result]; // legacy single-test shape
    return [];
  } catch (err) {
    return [];
  }
}

/**
 * generateIntentTests(classifiedPage, snapshot) → Array of test objects
 */
export async function generateIntentTests(classifiedPage, snapshot) {
  try {
    const prompt = buildIntentPrompt(classifiedPage, snapshot);
    const text = await generateText(prompt);
    const parsed = parseJSON(text);

    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.tests)) return parsed.tests;
    return [];
  } catch (err) {
    return [];
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
