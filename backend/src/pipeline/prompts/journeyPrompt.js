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
    // Append selector hints so the AI can write targeted Playwright code
    // instead of guessing from ambiguous text labels alone.
    const hints = [];
    if (act.role)      hints.push(`role="${act.role}"`);
    if (act.testId)    hints.push(`data-testid="${act.testId}"`);
    if (act.ariaLabel) hints.push(`aria-label="${act.ariaLabel}"`);
    if (act.selector)  hints.push(`selector: ${act.selector}`);
    if (hints.length > 0) desc += `  [${hints.join(", ")}]`;
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
When a step includes selector hints (role, data-testid, aria-label, selector), prefer those
over guessing from the text label — they were verified to resolve during exploration.
For NEGATIVE tests, vary the inputs (empty fields, wrong values) but use the same selectors/elements.`;
}

export function buildJourneyPrompt(journey, allSnapshots, { testCount = "ai_decides" } = {}) {
  const local = isLocalProvider();
  const pageContexts = journey.pages.map(page => {
    // Prefer fingerprint lookup for state-explorer journeys (multiple states
    // at the same URL). Falls back to URL lookup for legacy crawl journeys.
    const snapshot = (page._stateFingerprint && allSnapshots[page._stateFingerprint])
      || allSnapshots[page.url];
    // For local models (Ollama ≤8B) keep element data very compact to avoid
    // context overflow (HTTP 500). 5 pages × 4 elements is ~2K tokens — safe
    // for 8K-context models. Cloud models get the full 10 elements.
    const rawElems = (snapshot?.elements || []).slice(0, local ? 4 : 10);
    const elems = local
      ? rawElems.map(e => ({
          tag: e.tag, text: (e.text || "").slice(0, 30), type: e.type,
          role: e.role, name: e.name, testId: e.testId,
          // AUDIT-ROADMAP B2 — preserve iframe provenance in the compact
          // local-model projection. Without these two fields the LLM
          // can't tell which elements live inside an iframe and would
          // produce plain `page.locator(...)` calls that miss the frame.
          ...(e._fromIframe ? { _fromIframe: true, _iframeSrc: e._iframeSrc } : {}),
        }))
      : rawElems;
    return `
  Page: ${page.url}
  Title: ${page.title}
  Intent: ${page.dominantIntent}
  Key elements: ${JSON.stringify(elems, null, 2)}`;
  }).join("\n---");

  const firstUrl = journey.pages[0]?.url || "";

  // AUDIT-ROADMAP B2 — detect whether this journey crosses any iframes so
  // the prompt only ships the `safeSelectFrame` rule when it's relevant.
  // Keeps the prompt lean for the common (no-iframe) case — adding the
  // rule unconditionally would bloat every cloud prompt by ~150 tokens
  // and every local-model prompt by ~5% of its 8K context window.
  const hasIframeElements = journey.pages.some((page) => {
    const snap = (page._stateFingerprint && allSnapshots[page._stateFingerprint])
      || allSnapshots[page.url];
    return (snap?.elements || []).some((e) => e?._fromIframe);
  });
  const iframeRule = hasIframeElements ? `

IFRAME ELEMENTS (AUDIT-ROADMAP B2):
Some elements in the PAGE data above carry \`_fromIframe: true\` + \`_iframeSrc: "<url>"\`.
For those elements you MUST scope locators through the frame:
  const frame = safeSelectFrame(page, '<iframe-src-or-substring>');
  await safeClick(frame, 'Submit');         // pass frame, not page
  await safeFill(frame, 'Card number', '4242 4242 4242 4242');
NEVER use \`safeClick(page, …)\` / \`safeFill(page, …)\` for iframe elements — Playwright's
auto-frame-resolution works for trivial cases but breaks on payment frames (Stripe Elements),
chat widgets (Intercom), and any frame where the selector matches more than one descendant.
Use the iframe's URL as the frame identifier; \`safeSelectFrame\` accepts a substring match.` : "";

  // Include observed actions when available (state explorer mode)
  const observedBlock = buildObservedActionsBlock(journey._observedActions);

  const user = `JOURNEY: ${journey.name}
TYPE: ${journey.type}
DESCRIPTION: ${journey.description}

PAGES IN THIS JOURNEY:
${pageContexts}
${iframeRule}
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
