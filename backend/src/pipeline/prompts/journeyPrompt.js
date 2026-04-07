/**
 * journeyPrompt.js — Multi-page journey prompt template
 *
 * Builds the AI prompt for generating end-to-end Playwright tests that span
 * multiple pages (e.g. Login → Dashboard → Action → Logout).
 *
 * When the journey includes `_observedActions` (produced by the state explorer
 * in `pipeline/stateExplorer.js`), the prompt includes the exact sequence of
 * actions that were observed to work during exploration. This gives the AI
 * concrete evidence of what interactions succeed, rather than having to guess.
 *
 * Returns { system, user } for structured message support.
 */

import { isLocalProvider } from "../../aiProvider.js";
import { resolveTestCountInstruction } from "../promptHelpers.js";
import { buildSystemPrompt, buildOutputSchemaBlock } from "./outputSchema.js";

/**
 * Format observed actions from the state explorer into a prompt block.
 * Only included when `journey._observedActions` is present (state explorer mode).
 *
 * @param {Array} observedActions — from flowToJourney()._observedActions
 * @returns {string}
 */
function buildObservedActionsBlock(observedActions) {
  if (!observedActions || observedActions.length === 0) return "";

  const steps = observedActions.map((act, i) => {
    let desc = `  Step ${i + 1}: On ${act.onPage}`;
    if (act.actionType === "fill") {
      desc += `, filled "${act.target}" with "${act.value}"`;
    } else if (act.actionType === "click" || act.actionType === "submit") {
      desc += `, clicked "${act.target}"`;
    } else if (act.actionType === "select") {
      desc += `, selected option in "${act.target}"`;
    } else if (act.actionType === "check") {
      desc += `, checked "${act.target}"`;
    } else {
      desc += `, performed ${act.actionType} on "${act.target}"`;
    }
    if (act.resultPage && act.resultPage !== act.onPage) {
      desc += ` → navigated to ${act.resultPage}`;
    }
    return desc;
  }).join("\n");

  return `
OBSERVED ACTIONS (verified during live exploration — these interactions actually worked):
${steps}

IMPORTANT: Use the observed actions above as the basis for the POSITIVE test path.
The AI saw these actions succeed in a real browser. Reproduce them faithfully in playwrightCode.
For NEGATIVE tests, vary the inputs (empty fields, wrong values) but use the same selectors/elements.`;
}

export function buildJourneyPrompt(journey, allSnapshots, { testCount = "ai_decides" } = {}) {
  const local = isLocalProvider();
  const pageContexts = journey.pages.map(page => {
    // Prefer fingerprint lookup for state-explorer journeys (multiple states
    // at the same URL). Falls back to URL lookup for legacy crawl journeys.
    const snapshot = (page._stateFingerprint && allSnapshots[page._stateFingerprint])
      || allSnapshots[page.url];
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

  const firstUrl = journey.pages[0]?.url || "";

  // Include observed actions when available (state explorer mode)
  const observedBlock = buildObservedActionsBlock(journey._observedActions);

  const user = `JOURNEY: ${journey.name}
TYPE: ${journey.type}
DESCRIPTION: ${journey.description}

PAGES IN THIS JOURNEY:
${pageContexts}
${observedBlock}

${resolveTestCountInstruction(testCount, local)} end-to-end Playwright tests covering this journey from multiple angles.

Requirements:
1. Cover BOTH positive paths (happy paths) AND negative paths (error states, edge cases)
2. Each test must flow through multiple pages/steps logically
3. Include at least 3 meaningful assertions per test that verify SPECIFIC VISIBLE CONTENT
4. CRITICAL: Each test's playwrightCode MUST be fully self-contained — it MUST start with await page.goto('${firstUrl}', { waitUntil: 'domcontentloaded', timeout: 30000 }). Use the actual URL from the PAGE data above — never a placeholder.
5. Read the actual PAGE DATA above (titles, intents, elements) and assert against REAL content from those pages

${buildOutputSchemaBlock({ isJourney: true, journeyType: journey.type })}`;

  return { system: buildSystemPrompt(), user };
}
