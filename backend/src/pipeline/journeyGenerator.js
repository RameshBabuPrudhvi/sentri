/**
 * journeyGenerator.js — Layer 7: Generate user journey tests (multi-step flows)
 *
 * Instead of isolated "click button" tests, generates flows like:
 *   Login → Dashboard → Action → Logout
 *   Browse → Add to Cart → Checkout
 */

import { generateText, streamText, parseJSON, isLocalProvider } from "../aiProvider.js";
import { SELF_HEALING_PROMPT_RULES } from "../selfHealing.js";
import { throwIfAborted } from "../abortHelper.js";

/**
 * Resolve the test count instruction for prompt builders.
 *
 * Maps the validated testCount dial value to an authoritative instruction
 * string that replaces the previously hardcoded "Generate 3-5 / 5-8 tests"
 * ranges.  The instruction is worded imperatively so the LLM treats it as a
 * hard constraint rather than a suggestion.
 *
 * @param {string} testCount — validated dial value (single|few|moderate|comprehensive|auto)
 * @param {boolean} local    — true when using a local provider (Ollama)
 * @returns {string} e.g. "Generate EXACTLY 1 test" or "Generate 5-8 tests"
 */
function resolveTestCountInstruction(testCount, local) {
  switch (testCount) {
    case "single":        return "Generate EXACTLY 1 test";
    case "few":           return "Generate EXACTLY 3-5 tests";
    case "moderate":      return "Generate EXACTLY 6-10 tests";
    case "comprehensive": return "Generate EXACTLY 10-20 tests";
    case "auto":
    default:              return `Generate ${local ? "3-5" : "5-8"} tests`;
  }
}

/**
 * Inject an optional dialsPrompt into a base AI prompt, placing it
 * **before** the STRICT RULES / Requirements section so the LLM sees the
 * user's configuration (strategy, test count, format, etc.) before the
 * hardcoded generation defaults.  LLMs prioritise earlier context, so
 * appending dials at the very end caused them to be ignored when they
 * conflicted with rules like "Generate 5-8 tests".
 *
 * Injection strategy:
 *   1. Look for "STRICT RULES:" — used by buildIntentPrompt & buildUserRequestedPrompt
 *   2. Else look for "Requirements:" — used by buildJourneyPrompt
 *   3. Fallback: append at the end (safe default)
 */
function withDials(base, dialsPrompt) {
  if (!dialsPrompt) return base;

  // Find the best injection point — before the rules section
  const markers = ["STRICT RULES:", "Requirements:"];
  for (const marker of markers) {
    const idx = base.indexOf(marker);
    if (idx !== -1) {
      return (
        base.slice(0, idx).trimEnd() +
        "\n\n" + dialsPrompt + "\n\n" +
        base.slice(idx)
      );
    }
  }

  // Fallback: append at end (shouldn't happen with current prompts)
  return `${base}\n\n${dialsPrompt}`;
}

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
 * extractTestsArray(parsed) — normalise the 3 common AI response shapes into
 * a plain array of test objects:
 *   1. Already an array       → return as-is
 *   2. { tests: [...] }       → unwrap
 *   3. Single object { name } → wrap in array
 *   4. Anything else           → empty array
 */
function extractTestsArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.tests)) return parsed.tests;
  if (parsed && parsed.name) return [parsed];
  return [];
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

function buildJourneyPrompt(journey, allSnapshots, { testCount = "auto" } = {}) {
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

${resolveTestCountInstruction(testCount, local)} end-to-end Playwright tests covering this journey from multiple angles.

Requirements:
1. Cover BOTH positive paths (happy paths) AND negative paths (error states, edge cases)
2. Each test must flow through multiple pages/steps logically
3. ${SELF_HEALING_PROMPT_RULES}
4. Include at least 3 meaningful assertions per test (toHaveURL, toBeVisible, toContainText) — assertions may still use expect(page.getByRole(...)) or expect(page.getByText(...)) directly.
5. After every page.goto() call use { waitUntil: 'domcontentloaded' } — do NOT use waitForLoadState('networkidle') as many real-world sites (e.g. SPAs, e-commerce) fire continuous background requests and never reach networkidle, causing a 30 s timeout.
6. Tests must represent REAL user goals and behaviors
7. Negative tests should verify error messages and validation feedback
8. CRITICAL: Each test's playwrightCode MUST be fully self-contained — it MUST start with await page.goto('FULL_URL', { waitUntil: 'domcontentloaded', timeout: 30000 }) as the very first line inside the test function. Use the actual URL from the PAGE data above.
9. CRITICAL: Do NOT use placeholder URLs like 'https://example.com' — use the real page URL provided.
10. STABILITY: For URL assertions use regex patterns — e.g. await expect(page).toHaveURL(/\\/dashboard/i) instead of exact URL strings, because query params, trailing slashes, and redirects cause false failures.
11. STABILITY: After clicking a button or link that triggers navigation, wrap the click in Promise.all with page.waitForNavigation({ waitUntil: 'domcontentloaded' }) — e.g. await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), element.click()]). Never use waitForLoadState('networkidle') after a click — it times out on sites with background polling. For asserting dynamic content (search results, filters), use await page.waitForSelector('selector', { timeout: 15000 }) instead.

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
- POSITIVE: User clicks a navigation link and is taken to the correct destination page with expected content
- POSITIVE: User navigates to this page, verifies key content loads, then navigates to another section and back
- POSITIVE: Primary navigation links lead to the correct URLs and load the expected page titles
- POSITIVE: Key call-to-action buttons trigger the intended user flow (e.g. sign up, get started, learn more)
- POSITIVE: User completes a multi-step navigation: homepage → section page → detail page → back to homepage
- NEGATIVE: Broken or dead links are detected (clicking a link does not lead to a 404 or error page)
- NEGATIVE: Navigation state is preserved correctly after browser back/forward
- EDGE: Deep-linking directly to this page loads it correctly with all content visible
- EDGE: Page renders correctly and key interactive elements are functional after a full reload`,

    CRUD: `Generate ${testRange} tests covering:
- POSITIVE: Create new item with valid data succeeds
- POSITIVE: Created item appears in list immediately
- POSITIVE: Edit existing item and save persists changes
- NEGATIVE: Create with duplicate name shows error
- NEGATIVE: Required fields block save when empty
- EDGE: Delete shows confirmation dialog
- EDGE: Cancel edit discards unsaved changes`,

    CONTENT: `Generate ${testRange} tests covering:
- POSITIVE: User opens the page and main content/article is fully visible and readable
- POSITIVE: User clicks internal links within the content and is navigated to the correct destination
- POSITIVE: User scrolls through the page and all sections, images, and media load progressively
- POSITIVE: User clicks a related content link or "read more" and the target page loads with expected content
- NEGATIVE: Broken images or missing media are detected (no placeholder or 404 resources)
- NEGATIVE: External links open correctly without breaking the current page state
- EDGE: User navigates to the page via direct URL and all content renders without requiring prior navigation
- EDGE: Page content is accessible — headings are hierarchical and interactive elements are reachable`,
  };

  const hints = scenarioHints[pageType] || scenarioHints.NAVIGATION;

  return `You are a senior QA engineer. Generate comprehensive Playwright tests based on REAL user behavior patterns.
Every test must simulate a REAL USER ACTION (click, navigate, fill, scroll) and verify the OUTCOME — do NOT generate tests that only check whether elements exist on the page.

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
7. Skip tests for: footer, social icons, cookie banners — but DO test primary navigation links and CTAs that lead to real user flows
8. Tests must be independent — no shared state between tests
9. For NEGATIVE tests: assert the actual error message or validation indicator is visible
10. Only test elements/behaviors that ACTUALLY exist for this type of page
11. CRITICAL: Every playwrightCode MUST start with: await page.goto('${snapshot.url}', { waitUntil: 'domcontentloaded', timeout: 30000 }); — use the EXACT URL above, never a placeholder
12. CRITICAL: playwrightCode must be fully self-contained and executable on its own
13. STABILITY: For URL assertions use regex patterns or toContainText — e.g. await expect(page).toHaveURL(/\\/about/i) instead of exact URL strings, because query params, trailing slashes, and redirects cause false failures
14. STABILITY: After every page.goto() use { waitUntil: 'domcontentloaded' } — NEVER use waitForLoadState('networkidle') as SPAs and e-commerce sites (Amazon, etc.) continuously fire background requests and never reach networkidle, causing a guaranteed 30 s timeout. After clicking a button or link that causes navigation, use await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), element.click()]). For asserting dynamic content that loads after interaction (search results, filtered lists, modal contents), use await page.waitForSelector('selector', { timeout: 15000 }) before the expect() assertion.

Return ONLY valid JSON (no markdown, no code fences):
{
  "tests": [
    {
      "name": "descriptive name that includes what scenario (positive/negative) is tested",
      "description": "specific user goal or failure scenario being validated",
      "priority": "high|medium",
      "type": "${classifiedPage.dominantIntent.toLowerCase()}",
      "scenario": "positive|negative|edge_case",
      "steps": ["User opens the page", "User clicks a link or button to perform an action", "Assert: expected page or content is displayed"],
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
11. STABILITY: For URL assertions use regex patterns — e.g. await expect(page).toHaveURL(/\\/about/i) instead of exact URL strings, because query params, trailing slashes, and redirects cause false failures
12. STABILITY: After every page.goto() use { waitUntil: 'domcontentloaded' } — NEVER use waitForLoadState('networkidle'). After clicking something that navigates, use await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), element.click()]). For dynamic content assertions use await page.waitForSelector('selector', { timeout: 15000 }) before expect().

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
export async function generateUserRequestedTest(name, description, appUrl, onToken, { dialsPrompt = "", signal } = {}) {
  const prompt = withDials(buildUserRequestedPrompt(name, description, appUrl), dialsPrompt);
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
export async function generateJourneyTest(journey, snapshotsByUrl, { dialsPrompt = "", signal } = {}) {
  try {
    const prompt = withDials(buildJourneyPrompt(journey, snapshotsByUrl), dialsPrompt);
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
export async function generateIntentTests(classifiedPage, snapshot, { dialsPrompt = "", signal } = {}) {
  try {
    const prompt = withDials(buildIntentPrompt(classifiedPage, snapshot), dialsPrompt);
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
export async function generateAllTests(classifiedPages, journeys, snapshotsByUrl, onProgress, { dialsPrompt = "", signal } = {}) {
  const allTests = [];

  // 1. Generate journey tests (highest value — multi-page flows)
  for (const journey of journeys) {
    throwIfAborted(signal);
    onProgress?.(`🗺️  Generating journey tests: ${journey.name}`);
    const journeyTests = await generateJourneyTest(journey, snapshotsByUrl, { dialsPrompt, signal });
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

    const tests = await generateIntentTests(classifiedPage, snapshot, { dialsPrompt, signal });
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
    const tests = await generateIntentTests(classifiedPage, snapshot, { dialsPrompt, signal });
    for (const t of tests) {
      allTests.push({ ...t, sourceUrl: classifiedPage.url, pageTitle: snapshot.title });
    }
  }

  return allTests;
}