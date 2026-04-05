/**
 * journeyPrompt.js — Multi-page journey prompt template
 *
 * Builds the AI prompt for generating end-to-end Playwright tests that span
 * multiple pages (e.g. Login → Dashboard → Action → Logout).
 *
 * Returns { system, user } for structured message support.
 */

import { isLocalProvider } from "../../aiProvider.js";
import { resolveTestCountInstruction } from "../promptHelpers.js";
import { buildSystemPrompt, buildOutputSchemaBlock } from "./outputSchema.js";

export function buildJourneyPrompt(journey, allSnapshots, { testCount = "ai_decides" } = {}) {
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

  const firstUrl = journey.pages[0]?.url || "";

  const user = `JOURNEY: ${journey.name}
TYPE: ${journey.type}
DESCRIPTION: ${journey.description}

PAGES IN THIS JOURNEY:
${pageContexts}

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
