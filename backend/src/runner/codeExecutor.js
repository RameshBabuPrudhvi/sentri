/**
 * codeExecutor.js — Dynamic execution of AI-generated Playwright test bodies
 *
 * Responsibilities:
 *   1. Parse, clean, and patch the AI-generated code (via codeParsing.js)
 *   2. Inject self-healing runtime helpers (via selfHealing.js)
 *   3. Wrap the code in a new Function() and execute it against a live page
 *   4. Lazy-load Playwright's `expect` at runtime
 *
 * Exports:
 *   runGeneratedCode(page, context, playwrightCode, expect, healingHints)
 *   getExpect()
 */

import { extractTestBody, patchNetworkIdle, stripPlaywrightImports } from "./codeParsing.js";
import { getSelfHealingHelperCode, applyHealingTransforms } from "../selfHealing.js";

/**
 * runGeneratedCode(page, context, playwrightCode, expect, healingHints)
 *
 * Dynamically executes the AI-generated test body against the live page.
 * Returns { passed: true, healingEvents: [...] } or throws with the error.
 *
 * healingHints is an optional map of "action::label" → strategyIndex from
 * previous runs, injected into the runtime helpers so the winning strategy
 * is tried first (adaptive self-healing).
 */
export async function runGeneratedCode(page, context, playwrightCode, expect, healingHints) {
  const body = extractTestBody(playwrightCode);
  if (!body) {
    throw new Error("Could not parse test body from generated code");
  }

  const cleaned = applyHealingTransforms(patchNetworkIdle(stripPlaywrightImports(body)));
  const helpers = getSelfHealingHelperCode(healingHints);

  // eslint-disable-next-line no-new-func
  const fn = new Function("page", "context", "expect", `
    return (async () => {
      ${helpers}
      // Stubs for Playwright fixtures that some LLMs hallucinate in the function
      // signature but are not valid in our eval context (e.g. 'run', 'browser',
      // 'request'). Defining them as undefined prevents ReferenceError crashes.
      const run = undefined;
      const browser = context?.browser?.() ?? undefined;
      const request = undefined;
      let __testError = null;
      try {
        ${cleaned}
      } catch (e) {
        __testError = e;
      }
      // Always return healing events, even on failure, so the runner can
      // persist what we learned from earlier steps.
      if (__testError) {
        __testError.__healingEvents = __healingEvents;
        throw __testError;
      }
      return { __healingEvents };
    })();
  `);

  try {
    const result = await fn(page, context, expect);
    return { passed: true, healingEvents: result?.__healingEvents || [] };
  } catch (err) {
    err.__healingEvents = err.__healingEvents || [];
    throw err;
  }
}

/**
 * getExpect()
 *
 * Returns Playwright's `expect` function by lazy-importing it from the
 * test runner module.  We don't import at the top level because Playwright's
 * `expect` lives in @playwright/test which we don't load globally.
 */
export async function getExpect() {
  const { expect } = await import("@playwright/test");
  return expect;
}
