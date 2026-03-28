/**
 * journeyGenerator.js — Layer 7: Generate user journey tests (multi-step flows)
 *
 * Instead of isolated "click button" tests, generates flows like:
 *   Login → Dashboard → Action → Logout
 *   Browse → Add to Cart → Checkout
 */

import { generateText, parseJSON } from "../aiProvider.js";

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

  return `You are a senior QA engineer generating a user journey Playwright test.

JOURNEY: ${journey.name}
TYPE: ${journey.type}
DESCRIPTION: ${journey.description}

PAGES IN THIS JOURNEY:
${pageContexts}

Generate ONE comprehensive end-to-end Playwright test that simulates this complete user journey.

Requirements:
1. The test must flow through multiple pages/steps logically
2. Use role-based selectors: getByRole(), getByLabel(), getByText()
3. Include at least 3 meaningful assertions (toHaveURL, toBeVisible, toContainText)
4. Add page.waitForLoadState() between navigation steps
5. The test must represent a REAL user goal, not random clicks
6. Use descriptive variable names

Return ONLY valid JSON (no markdown):
{
  "name": "descriptive journey test name",
  "description": "what user goal this validates",
  "priority": "high",
  "type": "${journey.type.toLowerCase()}",
  "journeyType": "${journey.type}",
  "isJourneyTest": true,
  "steps": ["User opens login page", "User enters credentials", "User lands on dashboard"],
  "playwrightCode": "import { test, expect } from '@playwright/test';\n\ntest('...', async ({ page }) => {\n  // full journey code here\n});"
}`;
}

// ── Single page intent-based prompt ──────────────────────────────────────────

function buildIntentPrompt(classifiedPage, snapshot) {
  const elements = classifiedPage.classifiedElements
    .filter(({ confidence }) => confidence > 30)
    .slice(0, 15)
    .map(({ element, intent, confidence }) => ({ ...element, intent, confidence }));

  return `You are a senior QA engineer. Generate 2-3 high-quality Playwright tests for this page.

PAGE: ${snapshot.url}
TITLE: ${snapshot.title}
DOMINANT INTENT: ${classifiedPage.dominantIntent}
FORMS: ${snapshot.forms}

CLASSIFIED ELEMENTS (filtered, high-value only):
${JSON.stringify(elements, null, 2)}

RULES:
1. Focus ONLY on the dominant intent: ${classifiedPage.dominantIntent}
2. Each test must validate a REAL user goal
3. Use getByRole(), getByLabel(), getByText() selectors — NOT CSS selectors
4. Every test must have at least 2 strong assertions
5. BAD assertion: expect(page).toBeTruthy()
   GOOD assertion: await expect(page).toHaveURL(/dashboard/); await expect(page.getByText('Welcome')).toBeVisible();
6. Do NOT generate tests for footer, social icons, or navigation boilerplate
7. Tests should be independent (no shared state)

Return ONLY valid JSON (no markdown):
{
  "tests": [
    {
      "name": "clear intent-driven name",
      "description": "specific user goal being validated",
      "priority": "high",
      "type": "${classifiedPage.dominantIntent.toLowerCase()}",
      "steps": ["concrete step 1", "concrete step 2", "assertion step"],
      "playwrightCode": "import { test, expect } from '@playwright/test';\n\ntest('...', async ({ page }) => {\n  // complete test\n});"
    }
  ]
}`;
}

// ── Main generators ───────────────────────────────────────────────────────────

/**
 * generateJourneyTest(journey, snapshotsByUrl) → test object or null
 */
export async function generateJourneyTest(journey, snapshotsByUrl) {
  try {
    const prompt = buildJourneyPrompt(journey, snapshotsByUrl);
    const text = await generateText(prompt);
    const result = parseJSON(text);
    return result;
  } catch (err) {
    return null;
  }
}

/**
 * generateIntentTests(classifiedPage, snapshot) → Array of test objects
 *
 * Generates tests focused on the page's dominant intent.
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
 */
export async function generateAllTests(classifiedPages, journeys, snapshotsByUrl, onProgress) {
  const allTests = [];

  // 1. Generate journey tests (highest value)
  for (const journey of journeys) {
    onProgress?.(`🗺️  Generating journey: ${journey.name}`);
    const journeyTest = await generateJourneyTest(journey, snapshotsByUrl);
    if (journeyTest) {
      allTests.push({ ...journeyTest, sourceUrl: journey.pages[0]?.url, pageTitle: journey.name });
    }
  }

  // 2. Generate per-page intent tests for high-priority pages
  const coveredUrls = new Set(journeys.flatMap(j => j.pages.map(p => p.url)));

  for (const classifiedPage of classifiedPages) {
    if (!classifiedPage.isHighPriority) continue;

    // Skip if fully covered by a journey test
    if (coveredUrls.has(classifiedPage.url)) continue;

    onProgress?.(`🤖 Generating intent tests for: ${classifiedPage.url} [${classifiedPage.dominantIntent}]`);
    const snapshot = snapshotsByUrl[classifiedPage.url];
    if (!snapshot) continue;

    const tests = await generateIntentTests(classifiedPage, snapshot);
    for (const t of tests) {
      allTests.push({ ...t, sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
    }
  }

  // 3. Generate basic tests for low-priority pages (just navigation/visibility)
  for (const classifiedPage of classifiedPages) {
    if (classifiedPage.isHighPriority || coveredUrls.has(classifiedPage.url)) continue;
    const snapshot = snapshotsByUrl[classifiedPage.url];
    if (!snapshot) continue;

    // Only generate one basic visibility test per low-priority page
    onProgress?.(`📄 Basic test for: ${classifiedPage.url}`);
    try {
      const basicTests = await generateIntentTests(classifiedPage, snapshot);
      if (basicTests.length > 0) {
        allTests.push({ ...basicTests[0], sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
      }
    } catch {}
  }

  return allTests;
}
