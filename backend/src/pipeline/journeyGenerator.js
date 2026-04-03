/**
 * journeyGenerator.js — Layer 7: Generate user journey tests (multi-step flows)
 *
 * Instead of isolated "click button" tests, generates flows like:
 *   Login → Dashboard → Action → Logout
 *   Browse → Add to Cart → Checkout
 */

import { generateText, streamText, parseJSON, isLocalProvider } from "../aiProvider.js";
import { SELF_HEALING_PROMPT_RULES } from "../selfHealing.js";

// ── Step sanitiser — converts Playwright code lines to human-readable steps ──

const CODE_PATTERNS = [
  /^\s*await\s+/,
  /^\s*page\./,
  /^\s*expect\s*\(/,
  /^\s*const\s+/,
  /^\s*let\s+/,
  /^\s*import\s+/,
  /^\s*test\s*\(/,
  /^\s*\/\//,
  /^\s*}\s*\)\s*;?\s*$/,
];

function looksLikeCode(step) {
  if (!step || typeof step !== "string") return false;
  return CODE_PATTERNS.some(re => re.test(step));
}

/**
 * Convert a Playwright code line into a human-readable step description.
 * e.g. "await page.goto('https://example.com')" → "Navigate to https://example.com"
 */
function codeToHumanStep(code) {
  const s = code.trim();

  // page.goto
  const gotoMatch = s.match(/page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (gotoMatch) return `Navigate to ${gotoMatch[1]}`;

  // page.click / page.getByRole(...).click
  const clickMatch = s.match(/\.click\s*\(/);
  if (clickMatch) {
    const label = extractLabel(s);
    return label ? `Click "${label}"` : "Click element";
  }

  // page.fill / .fill
  const fillMatch = s.match(/\.fill\s*\(\s*['"`]?([^'"`),]*)['"`]?\s*,\s*['"`]([^'"`]*)['"`]/);
  if (fillMatch) return `Enter "${fillMatch[2]}" into ${fillMatch[1] || "field"}`;

  // expect(...).toBeVisible
  if (/toBeVisible/.test(s)) {
    const label = extractLabel(s);
    return label ? `Verify "${label}" is visible` : "Verify element is visible";
  }

  // expect(...).toHaveURL
  const urlMatch = s.match(/toHaveURL\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (urlMatch) return `Verify URL is ${urlMatch[1]}`;

  // expect(...).toContainText
  const textMatch = s.match(/toContainText\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (textMatch) return `Verify text "${textMatch[1]}" is present`;

  // page.waitForLoadState
  if (/waitForLoadState/.test(s)) return "Wait for page to load";

  // Generic fallback — strip await/page prefix and camelCase → words
  const stripped = s.replace(/^await\s+/, "").replace(/^page\./, "");
  const words = stripped.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[()'"`;{}]/g, "").trim();
  return words.length > 80 ? words.slice(0, 77) + "…" : words || "Perform action";
}

function extractLabel(code) {
  // getByRole('button', { name: 'Submit' })
  const roleMatch = code.match(/getByRole\s*\(\s*['"`][^'"`]*['"`]\s*,\s*\{[^}]*name\s*:\s*['"`]([^'"`]+)['"`]/);
  if (roleMatch) return roleMatch[1];
  // getByText('...')
  const textMatch = code.match(/getByText\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (textMatch) return textMatch[1];
  // getByLabel('...')
  const labelMatch = code.match(/getByLabel\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (labelMatch) return labelMatch[1];
  // getByPlaceholder('...')
  const phMatch = code.match(/getByPlaceholder\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (phMatch) return phMatch[1];
  return null;
}

/**
 * sanitiseSteps(tests)
 * If a test's steps array contains Playwright code instead of human-readable
 * descriptions (common with smaller LLMs like Mistral 7B), convert them.
 */
function sanitiseSteps(tests) {
  for (const t of tests) {
    if (!Array.isArray(t.steps) || t.steps.length === 0) continue;
    const codeCount = t.steps.filter(looksLikeCode).length;
    // If more than half the steps look like code, convert all of them
    if (codeCount > t.steps.length / 2) {
      t.steps = t.steps
        .filter(s => s && typeof s === "string" && s.trim())
        .filter(s => !/^\s*}\s*\)\s*;?\s*$/.test(s))           // drop closing braces
        .filter(s => !/^\s*import\s+/.test(s))                  // drop import lines
        .filter(s => !/^\s*test\s*\(/.test(s))                  // drop test(...) wrappers
        .map(s => looksLikeCode(s) ? codeToHumanStep(s) : s);
    }
  }
  return tests;
}

// ── Journey prompt builder ────────────────────────────────────────────────────

function buildJourneyPrompt(journey, allSnapshots) {
  const local = isLocalProvider();
  const pageContexts = journey.pages.map(page => {
    const snapshot = allSnapshots[page.url];
    // For local models (Ollama) keep element data compact to avoid context overflow (HTTP 500)
    const rawElems = (snapshot?.elements || []).slice(0, local ? 8 : 10);
    const elems = local
      ? rawElems.map(e => ({
          tag: e.tag, text: (e.text || "").slice(0, 40), type: e.type,
          role: e.role, name: e.name, testId: e.testId,
        }))
      : rawElems;
    return `
  Page: ${page.url}
  Title: ${page.title}
  Intent: ${page.dominantIntent}
  Key elements: ${JSON.stringify(elems, null, 2)}`;
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
4. Include at least 3 meaningful assertions per test (toHaveURL, toBeVisible, toContainText) — assertions may still use expect(page.getByRole(...)) or expect(page.getByText(...)) directly.
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
      "steps": ["User opens the login page", "User enters valid credentials and clicks Sign In", "Assert: user is redirected to the dashboard"],
      "playwrightCode": "import { test, expect } from '@playwright/test';\n\ntest('...', async ({ page }) => {\n  // full journey code here\n});"
    }
  ]
}

IMPORTANT: The "steps" array must contain SHORT HUMAN-READABLE descriptions of what the user does (plain English), NOT Playwright code. Playwright code goes ONLY in "playwrightCode".
BAD steps:  ["await page.goto('...')", "await page.click('.btn')"]
GOOD steps: ["User opens the homepage", "User clicks the Sign In button"]`;
}

// ── Single page intent-based prompt ──────────────────────────────────────────

function buildIntentPrompt(classifiedPage, snapshot) {
  const local = isLocalProvider();
  // For local models (Ollama) keep element data compact to avoid context overflow (HTTP 500).
  // Cloud models get the full element data for richer test generation.
  const elements = classifiedPage.classifiedElements
    .filter(({ confidence }) => confidence > 20)
    .slice(0, local ? 12 : 20)
    .map(({ element, intent, confidence }) => {
      if (local) {
        return {
          tag: element.tag, text: (element.text || "").slice(0, 40),
          type: element.type, role: element.role,
          name: element.name, id: element.id,
          label: element.label, placeholder: element.placeholder,
          testId: element.testId, intent, confidence,
        };
      }
      return { ...element, intent, confidence };
    });

  const pageType = classifiedPage.dominantIntent;

  const testRange = local ? "3-5" : "5-8";
  const scenarioHints = {
    AUTH: `Generate ${testRange} tests covering:
- POSITIVE: Successful login with valid credentials redirects to dashboard
- POSITIVE: Registration form accepts valid new user data  
- NEGATIVE: Wrong password shows clear error message
- NEGATIVE: Empty required fields show validation errors
- NEGATIVE: Invalid email format blocked before submit
- EDGE: Password visibility toggle works
- EDGE: Forgot password link is accessible`,

    SEARCH: `Generate ${testRange} tests covering:
- POSITIVE: Search returns relevant results for valid query
- POSITIVE: Search filters narrow down results correctly
- POSITIVE: Clicking a result navigates to detail page
- NEGATIVE: Empty search query handled gracefully
- NEGATIVE: No results for unknown term shows empty state
- EDGE: Special characters in search don't break the page
- EDGE: Very long search query is handled`,

    CHECKOUT: `Generate ${testRange} tests covering:
- POSITIVE: Add item to cart and view cart with correct total
- POSITIVE: Quantity update recalculates cart total
- POSITIVE: Proceed to checkout from cart page
- NEGATIVE: Invalid payment details show error
- NEGATIVE: Empty required checkout fields blocked
- EDGE: Remove item from cart updates totals
- EDGE: Cart persists on page refresh`,

    FORM_SUBMISSION: `Generate ${testRange} tests covering:
- POSITIVE: Form submits with all valid required fields
- POSITIVE: Success confirmation is shown after submit
- NEGATIVE: Submit with empty required fields shows validation
- NEGATIVE: Invalid email format shows error before submit
- NEGATIVE: Duplicate submission is prevented
- EDGE: Form scrolls to first error field on failed submit
- EDGE: Character limits enforced on text inputs`,

    NAVIGATION: `Generate ${testRange} tests covering:
- POSITIVE: Page title and main heading (H1) are visible and correct
- POSITIVE: Primary navigation links are present and clickable
- POSITIVE: Clicking the logo/brand returns to homepage
- POSITIVE: Key call-to-action buttons are visible and enabled
- POSITIVE: Page loads without console errors (no 404 resources)
- NEGATIVE: 404 URL shows appropriate not-found page
- EDGE: Keyboard navigation reaches all interactive elements
- EDGE: Page is correctly structured with semantic headings`,

    CRUD: `Generate ${testRange} tests covering:
- POSITIVE: Create new item with valid data succeeds
- POSITIVE: Created item appears in list immediately  
- POSITIVE: Edit existing item and save persists changes
- NEGATIVE: Create with duplicate name shows error
- NEGATIVE: Required fields block save when empty
- EDGE: Delete shows confirmation dialog
- EDGE: Cancel edit discards unsaved changes`,

    CONTENT: `Generate ${testRange} tests covering:
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
DESCRIPTION: ${snapshot.metaDescription || "none"}
HEADINGS: ${JSON.stringify(snapshot.headings || [], null, 2)}

CLASSIFIED INTERACTIVE ELEMENTS:
${JSON.stringify(elements, null, 2)}

REQUIRED SCENARIO COVERAGE:
${hints}

STRICT RULES:
1. Generate ${local ? "3-5" : "5-8"} tests — must include BOTH positive AND negative scenarios
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
      "steps": ["User opens the page", "User fills in the search field with a query", "Assert: search results are displayed"],
      "playwrightCode": "import { test, expect } from '@playwright/test';\n\ntest('...', async ({ page }) => {\n  // complete test code\n});"
    }
  ]
}

IMPORTANT: The "steps" array must contain SHORT HUMAN-READABLE descriptions of what the user does (plain English), NOT Playwright code. Playwright code goes ONLY in "playwrightCode".
BAD steps:  ["await page.goto('...')", "await page.click('.btn')"]
GOOD steps: ["User opens the homepage", "User clicks the Sign In button"]`;
}

// ── User-requested single test prompt ─────────────────────────────────────────
// Used by generateSingleTest (POST /api/projects/:id/tests/generate) when a
// user provides a specific name + description. Unlike buildIntentPrompt which
// generates 5-8 generic tests from crawled page data, this prompt generates
// exactly ONE focused test that matches the user's stated intent.

function buildUserRequestedPrompt(name, description, appUrl) {
  return `You are a senior QA engineer. A user has asked you to create ONE specific Playwright test.

TEST NAME: ${name}
USER DESCRIPTION: ${description || "(no description provided)"}
APPLICATION URL: ${appUrl}

Your job is to generate a SINGLE test that precisely matches the user's request above.
Do NOT generate generic tests. Do NOT generate tests unrelated to the title and description.
The test MUST directly verify what the user described — nothing more, nothing less.

STRICT RULES:
1. Generate EXACTLY 1 test — focused entirely on what the user described
2. The test name should match or closely reflect the user's provided name
3. Steps must be specific to the described scenario, not generic page checks
4. ${SELF_HEALING_PROMPT_RULES}
5. Every test MUST have at least 2 strong assertions
6. STRONG assertions: toHaveURL(), toBeVisible(), toContainText(), toHaveValue(), toBeEnabled()
7. WEAK (forbidden): toBeTruthy(), toBeDefined(), toEqual(true)
8. CRITICAL: playwrightCode MUST start with: await page.goto('${appUrl}', { waitUntil: 'domcontentloaded', timeout: 30000 });
9. CRITICAL: playwrightCode must be fully self-contained and executable on its own
10. CRITICAL: Do NOT use placeholder URLs like 'https://example.com' — use '${appUrl}'

Return ONLY valid JSON (no markdown, no code fences):
{
  "tests": [
    {
      "name": "${name}",
      "description": "${(description || "").replace(/"/g, '\\"').slice(0, 200)}",
      "priority": "high",
      "type": "user-requested",
      "scenario": "positive",
      "steps": ["User navigates to the application", "User performs the described action", "Assert: expected outcome is verified"],
      "playwrightCode": "import { test, expect } from '@playwright/test';\\n\\ntest('${name.replace(/'/g, "\\'")}', async ({ page }) => {\\n  // complete test code\\n});"
    }
  ]
}

IMPORTANT: The "steps" array must contain SHORT HUMAN-READABLE descriptions of what the user does (plain English), NOT Playwright code. Playwright code goes ONLY in "playwrightCode".
BAD steps:  ["await page.goto('...')", "await page.click('.btn')"]
GOOD steps: ["User opens the homepage", "User clicks the Sign In button"]`;
}

/**
 * generateUserRequestedTest(name, description, appUrl) → Array of test objects
 *
 * Generates exactly ONE test focused on the user's provided name + description.
 * Used by the POST /api/projects/:id/tests/generate endpoint instead of the
 * generic generateIntentTests which produces 5-8 crawl-oriented tests.
 */
export async function generateUserRequestedTest(name, description, appUrl, onToken, dialsPrompt = "") {
  const base = buildUserRequestedPrompt(name, description, appUrl);
  const prompt = dialsPrompt ? `${base}\n\n${dialsPrompt}` : base;
  const text = onToken
    ? await streamText(prompt, onToken)
    : await generateText(prompt);
  const parsed = parseJSON(text);

  let tests = [];
  if (Array.isArray(parsed)) tests = parsed;
  else if (Array.isArray(parsed.tests)) tests = parsed.tests;
  else if (parsed && parsed.name) tests = [parsed];

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
export async function generateJourneyTest(journey, snapshotsByUrl, dialsPrompt = "") {
  try {
    const base = buildJourneyPrompt(journey, snapshotsByUrl);
    const prompt = dialsPrompt ? `${base}\n\n${dialsPrompt}` : base;
    const text = await generateText(prompt);
    const result = parseJSON(text);

    let tests;
    if (Array.isArray(result)) tests = result;
    else if (Array.isArray(result.tests)) tests = result.tests;
    else if (result && result.name) tests = [result]; // legacy single-test shape
    else return [];

    sanitiseSteps(tests);
    return tests;
  } catch (err) {
    return [];
  }
}

/**
 * generateIntentTests(classifiedPage, snapshot) → Array of test objects
 */
export async function generateIntentTests(classifiedPage, snapshot, dialsPrompt = "") {
  try {
    const base = buildIntentPrompt(classifiedPage, snapshot);
    const prompt = dialsPrompt ? `${base}\n\n${dialsPrompt}` : base;
    const text = await generateText(prompt);
    const parsed = parseJSON(text);

    let tests;
    if (Array.isArray(parsed)) tests = parsed;
    else if (Array.isArray(parsed.tests)) tests = parsed.tests;
    else return [];

    sanitiseSteps(tests);
    return tests;
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
export async function generateAllTests(classifiedPages, journeys, snapshotsByUrl, onProgress, dialsPrompt = "") {
  const allTests = [];

  // 1. Generate journey tests (highest value — multi-page flows)
  for (const journey of journeys) {
    onProgress?.(`🗺️  Generating journey tests: ${journey.name}`);
    const journeyTests = await generateJourneyTest(journey, snapshotsByUrl, dialsPrompt);
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

    const tests = await generateIntentTests(classifiedPage, snapshot, dialsPrompt);
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
    const tests = await generateIntentTests(classifiedPage, snapshot, dialsPrompt);
    for (const t of tests) {
      allTests.push({ ...t, sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
    }
  }

  return allTests;
}
