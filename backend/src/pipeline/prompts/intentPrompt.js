/**
 * intentPrompt.js — Single-page intent-based prompt template
 *
 * Builds the AI prompt for generating Playwright tests based on the
 * classified intent of a single page (AUTH, SEARCH, CHECKOUT, etc.)
 * and its interactive elements.
 *
 * Returns { system, user } for structured message support.
 * System message: persona, rules, schema (from outputSchema.js)
 * User message: page data, elements, scenario hints, page-specific rules
 */

import { isLocalProvider } from "../../aiProvider.js";
import { resolveTestCountInstruction } from "../promptHelpers.js";
import { buildSystemPrompt, buildOutputSchemaBlock } from "./outputSchema.js";

// ── Scenario hints per page type ─────────────────────────────────────────────

function buildScenarioHints(testCountInstr) {
  return {
    AUTH: `${testCountInstr} covering:
- POSITIVE: Successful login with valid credentials redirects to dashboard
- POSITIVE: Registration form accepts valid new user data
- NEGATIVE: Wrong password shows clear error message
- NEGATIVE: Empty required fields show validation errors
- NEGATIVE: Invalid email format blocked before submit
- EDGE: Password visibility toggle works
- EDGE: Forgot password link is accessible`,

    SEARCH: `${testCountInstr} covering:
- POSITIVE: Search returns relevant results for valid query
- POSITIVE: Search filters narrow down results correctly
- POSITIVE: Clicking a result navigates to detail page
- NEGATIVE: Empty search query handled gracefully
- NEGATIVE: No results for unknown term shows empty state
- EDGE: Special characters in search don't break the page
- EDGE: Very long search query is handled`,

    CHECKOUT: `${testCountInstr} covering:
- POSITIVE: Add item to cart and view cart with correct total
- POSITIVE: Quantity update recalculates cart total
- POSITIVE: Proceed to checkout from cart page
- NEGATIVE: Invalid payment details show error
- NEGATIVE: Empty required checkout fields blocked
- EDGE: Remove item from cart updates totals
- EDGE: Cart persists on page refresh`,

    FORM_SUBMISSION: `${testCountInstr} covering:
- POSITIVE: Form submits with all valid required fields
- POSITIVE: Success confirmation is shown after submit
- NEGATIVE: Submit with empty required fields shows validation
- NEGATIVE: Invalid email format shows error before submit
- NEGATIVE: Duplicate submission is prevented
- EDGE: Form scrolls to first error field on failed submit
- EDGE: Character limits enforced on text inputs`,

    NAVIGATION: `${testCountInstr} covering:
- POSITIVE: User clicks a navigation link and is taken to the correct destination page with expected content
- POSITIVE: User navigates to this page, verifies key content loads, then navigates to another section and back
- POSITIVE: Primary navigation links lead to the correct URLs and load the expected page titles
- POSITIVE: Key call-to-action buttons trigger the intended user flow (e.g. sign up, get started, learn more)
- POSITIVE: User completes a multi-step navigation: homepage → section page → detail page → back to homepage
- NEGATIVE: Broken or dead links are detected (clicking a link does not lead to a 404 or error page)
- NEGATIVE: Navigation state is preserved correctly after browser back/forward
- EDGE: Deep-linking directly to this page loads it correctly with all content visible
- EDGE: Page renders correctly and key interactive elements are functional after a full reload`,

    CRUD: `${testCountInstr} covering:
- POSITIVE: Create new item with valid data succeeds
- POSITIVE: Created item appears in list immediately
- POSITIVE: Edit existing item and save persists changes
- NEGATIVE: Create with duplicate name shows error
- NEGATIVE: Required fields block save when empty
- EDGE: Delete shows confirmation dialog
- EDGE: Cancel edit discards unsaved changes`,

    CONTENT: `${testCountInstr} covering:
- POSITIVE: User opens the page and main content/article is fully visible and readable
- POSITIVE: User clicks internal links within the content and is navigated to the correct destination
- POSITIVE: User scrolls through the page and all sections, images, and media load progressively
- POSITIVE: User clicks a related content link or "read more" and the target page loads with expected content
- NEGATIVE: Broken images or missing media are detected (no placeholder or 404 resources)
- NEGATIVE: External links open correctly without breaking the current page state
- EDGE: User navigates to the page via direct URL and all content renders without requiring prior navigation
- EDGE: Page content is accessible — headings are hierarchical and interactive elements are reachable`,
  };
}

// ── Main prompt builder ──────────────────────────────────────────────────────

export function buildIntentPrompt(classifiedPage, snapshot, { testCount = "ai_decides" } = {}) {
  const local = isLocalProvider();
  // For local models (Ollama ≤8B) keep element data very compact to avoid
  // context overflow (HTTP 500). 6 elements × compact fields ≈ 600 tokens.
  // Cloud models get the full element data for richer test generation.
  const elements = classifiedPage.classifiedElements
    .filter(({ confidence }) => confidence > 20)
    .slice(0, local ? 6 : 20)
    .map(({ element, intent, confidence }) => {
      if (local) {
        return {
          tag: element.tag, text: (element.text || "").slice(0, 30),
          type: element.type, role: element.role,
          name: element.name, id: element.id,
          label: element.label, placeholder: element.placeholder,
          testId: element.testId, intent, confidence,
        };
      }
      return { ...element, intent, confidence };
    });

  const pageType = classifiedPage.dominantIntent;

  const testCountInstr = resolveTestCountInstruction(testCount, local);
  const scenarioHints = buildScenarioHints(testCountInstr);
  const hints = scenarioHints[pageType] || scenarioHints.NAVIGATION;

  const user = `PAGE DATA:
  URL: ${snapshot.url}
  Title: ${snapshot.title}
  Dominant intent: ${pageType}
  Forms on page: ${snapshot.forms}
  H1: ${snapshot.h1 || "none"}
  Description: ${snapshot.metaDescription || "none"}
  Headings: ${JSON.stringify(snapshot.headings || [], null, 2)}

CLASSIFIED INTERACTIVE ELEMENTS:
${JSON.stringify(elements, null, 2)}

REQUIRED SCENARIO COVERAGE:
${hints}

STRICT RULES:
1. ${testCountInstr} — must include BOTH positive AND negative scenarios
2. Each test validates a REAL user goal or validates graceful failure handling
3. CRITICAL: Every playwrightCode MUST start with: await page.goto('${snapshot.url}', { waitUntil: 'domcontentloaded', timeout: 30000 }); — use the EXACT URL above, never a placeholder
4. Read the actual PAGE DATA above (title, headings, elements) and assert against STRUCTURAL content from that page (headings, labels, button text, form fields). Do NOT hard-code dynamic values (usernames, dates, order IDs, counts, prices) — use regex patterns instead (see DYNAMIC CONTENT rules in system prompt)

${buildOutputSchemaBlock()}`;

  return { system: buildSystemPrompt(), user };
}
