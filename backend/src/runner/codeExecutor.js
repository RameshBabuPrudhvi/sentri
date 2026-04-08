/**
 * codeExecutor.js — Dynamic execution of AI-generated Playwright test bodies
 *
 * Responsibilities:
 *   1. Parse, clean, and patch the AI-generated code (via codeParsing.js)
 *   2. Inject self-healing runtime helpers (via selfHealing.js)
 *   3. Wrap the code in a new Function() and execute it against a live page
 *   4. Lazy-load Playwright's `expect` at runtime
 *   5. Provide a real Playwright `request` fixture for API tests
 *
 * Exports:
 *   runGeneratedCode(page, context, playwrightCode, expect, healingHints)
 *   runApiTestCode(playwrightCode, expect)
 *   getExpect()
 */

import { extractTestBody, patchNetworkIdle, stripPlaywrightImports, stripHallucinatedPageAssertions, repairBrokenStringLiterals } from "./codeParsing.js";
import { getSelfHealingHelperCode, applyHealingTransforms } from "../selfHealing.js";
import playwright from "playwright";

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

  const cleaned = repairBrokenStringLiterals(
    applyHealingTransforms(
      patchNetworkIdle(stripPlaywrightImports(body))
    )
  );
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
 * runApiTestCode(playwrightCode, expect)
 *
 * Executes an API-only test that uses Playwright's `request.newContext()`
 * instead of a browser page. Creates a real APIRequestContext, runs the
 * generated code, and cleans up afterwards.
 *
 * Returns { passed: true } or throws with the error.
 */
export async function runApiTestCode(playwrightCode, expect) {
  const body = extractTestBody(playwrightCode);
  if (!body) {
    throw new Error("Could not parse test body from generated code");
  }

  const cleaned = repairBrokenStringLiterals(
    stripHallucinatedPageAssertions(
      patchNetworkIdle(stripPlaywrightImports(body))
    )
  );

  // Compile the function BEFORE creating the request context so that a
  // SyntaxError in the AI-generated code doesn't leak the HTTP context.
  // new Function() only parses — it doesn't execute — so it doesn't need
  // the request object yet.
  // eslint-disable-next-line no-new-func
  const fn = new Function("request", "expect", "__apiLogs", `
    return (async () => {
      // API tests don't use page/context — provide stubs to prevent ReferenceError
      const page = undefined;
      const context = undefined;
      const run = undefined;
      const browser = undefined;
      let __testError = null;
      try {
        ${cleaned}
      } catch (e) {
        __testError = e;
      }
      if (__testError) {
        throw __testError;
      }
      return { passed: true };
    })();
  `);

  // Now that we know the code is syntactically valid, create the context.
  const apiLogs = [];
  const request = await playwright.request.newContext({
    ignoreHTTPSErrors: true,
  });

  // Helper: wrap HTTP methods on an APIRequestContext to capture logs.
  // NOTE: We intentionally exclude "fetch" from instrumentation. Playwright's
  // named methods (get, post, put, …) internally delegate to fetch(), so
  // instrumenting both would double-log every request. If the AI code calls
  // fetch() directly, it still works — it just won't appear in the API logs
  // (the named method wrappers cover 99% of AI-generated patterns).
  function instrumentContext(ctx) {
    for (const method of ["get", "post", "put", "patch", "delete", "head"]) {
      if (typeof ctx[method] === "function") {
        const original = ctx[method].bind(ctx);
        ctx[method] = async (...args) => {
          const start = Date.now();
          const url = typeof args[0] === "string" ? args[0] : String(args[0]);
          const httpMethod = method.toUpperCase();
          const reqHeaders = args[1]?.headers || null;
          const reqData = args[1]?.data != null ? (typeof args[1].data === "string" ? args[1].data : JSON.stringify(args[1].data)) : null;
          const entry = {
            method: httpMethod, url, startTime: start,
            status: null, duration: null, size: null,
            requestHeaders: reqHeaders,
            requestBody: reqData,
            responseHeaders: null,
            responseBody: null,
          };
          try {
            const resp = await original(...args);
            entry.status = resp.status();
            entry.duration = Date.now() - start;
            try {
              const bodyBuf = await resp.body();
              entry.size = bodyBuf.length;
              // Capture response body (text) — cap at 32KB to avoid bloating run results
              const bodyText = bodyBuf.toString("utf-8");
              entry.responseBody = bodyText.length > 32768 ? bodyText.slice(0, 32768) + "\n…(truncated)" : bodyText;
            } catch { entry.size = 0; }
            try { entry.responseHeaders = resp.headers(); } catch { /* ignore */ }
            apiLogs.push(entry);
            return resp;
          } catch (err) {
            entry.duration = Date.now() - start;
            entry.status = 0;
            apiLogs.push(entry);
            throw err;
          }
        };
      }
    }
  }

  instrumentContext(request);

  // AI-generated code may call request.newContext({ baseURL: '...' }) which
  // requires the APIRequest factory (playwright.request), not the
  // APIRequestContext we created above. Add a shim so both patterns work.
  const subContexts = [];
  request.newContext = async (options) => {
    const ctx = await playwright.request.newContext({ ignoreHTTPSErrors: true, ...options });
    subContexts.push(ctx);
    instrumentContext(ctx);
    return ctx;
  };

  try {
    await fn(request, expect, apiLogs);
    return { passed: true, apiLogs };
  } catch (err) {
    err.__apiLogs = apiLogs;
    throw err;
  } finally {
    for (const ctx of subContexts) {
      await ctx.dispose().catch(() => {});
    }
    await request.dispose().catch(() => {});
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
