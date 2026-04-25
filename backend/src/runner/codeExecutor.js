/**
 * codeExecutor.js — Sandboxed execution of AI-generated Playwright test bodies
 *
 * Responsibilities:
 *   1. Parse, clean, and patch the AI-generated code (via codeParsing.js)
 *   2. Inject self-healing runtime helpers (via selfHealing.js)
 *   3. Execute the code in a **vm sandbox** with a restricted global context
 *   4. Lazy-load Playwright's `expect` at runtime
 *   5. Provide a real Playwright `request` fixture for API tests
 *
 * ### Security model
 * AI-generated code runs inside a vm context that sets `process: undefined`
 * in the global scope. However, any injected host object (page, expect,
 * Buffer, etc.) exposes the host's Function constructor via
 * `.constructor.constructor`, which can be used to escape the sandbox:
 *
 *   `page.constructor.constructor('return process')()`
 *
 * Node.js docs explicitly warn: "The vm module is not a security mechanism.
 * Do not use it to run untrusted code."
 *
 * We block `process.exit()`, `process.kill()`, and `process.abort()` so
 * escaped code cannot crash the server. We do NOT strip `process.env` because
 * doing so breaks concurrent Express handlers (JWT verification, AI provider
 * calls, SQLite operations) that read env vars between await points during
 * async test execution.
 *
 * For true env isolation (preventing sandbox-escaped code from reading API
 * keys), use worker_threads with `env: {}` — see NEXT_STEPS.md S1-02.
 *
 * Exports:
 *   runGeneratedCode(page, context, playwrightCode, expect, healingHints, { onStepCapture? })
 *   runApiTestCode(playwrightCode, expect, { signal? })
 *   getExpect()
 */

import vm from "vm";
import { extractTestBody, patchNetworkIdle, stripPlaywrightImports, stripHallucinatedPageAssertions, repairBrokenStringLiterals } from "./codeParsing.js";
import { getSelfHealingHelperCode, applyHealingTransforms } from "../selfHealing.js";
import playwright from "playwright";

// ─── Sandbox helpers ──────────────────────────────────────────────────────────

/**
 * Build a vm context for executing AI-generated Playwright code.
 *
 * Injects only the objects the test needs (page, context, expect, etc.)
 * plus Node.js globals that vm.createContext() doesn't provide automatically.
 * Dangerous globals (process, require, global, etc.) are explicitly blocked.
 *
 * NOTE: Any injected host object can be used to reach the host's Function
 * constructor via `.constructor.constructor`. The env-stripping in
 * runWithStrippedEnv() is the actual security boundary, not this context.
 *
 * @param {Object} exposed — caller-provided objects to inject
 * @returns {Object} A vm context object
 */
function buildSandboxContext(exposed) {
  const safeConsole = Object.freeze({
    log:   (...args) => console.log(...args),
    warn:  (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    info:  (...args) => console.info(...args),
  });

  return vm.createContext({
    // ── Caller-provided objects (Playwright page, context, expect, etc.) ────
    ...exposed,

    // ── Wrapped host functions (arrow functions hide host Function ctor) ────
    console:        safeConsole,
    setTimeout:     (...args) => setTimeout(...args),
    clearTimeout:   (...args) => clearTimeout(...args),
    setInterval:    (...args) => setInterval(...args),
    clearInterval:  (...args) => clearInterval(...args),

    // ── Node.js globals NOT provided by vm.createContext() ────────────────
    // vm.createContext() provides ECMAScript built-ins (Error, Promise,
    // Array, Object, Date, RegExp, Map, Set, etc.) as sandbox-local copies.
    // Node.js-specific globals must be injected explicitly.
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    DOMException,
    Buffer,
    NaN,
    Infinity,
    undefined,
    isNaN:              (...args) => isNaN(...args),
    isFinite:           (...args) => isFinite(...args),
    parseInt:           (...args) => parseInt(...args),
    parseFloat:         (...args) => parseFloat(...args),
    encodeURIComponent: (...args) => encodeURIComponent(...args),
    decodeURIComponent: (...args) => decodeURIComponent(...args),
    encodeURI:          (...args) => encodeURI(...args),
    decodeURI:          (...args) => decodeURI(...args),
    atob:               typeof atob === "function" ? (...args) => atob(...args) : undefined,
    btoa:               typeof btoa === "function" ? (...args) => btoa(...args) : undefined,
    structuredClone:    typeof structuredClone === "function" ? (...args) => structuredClone(...args) : undefined,

    // ── Explicitly blocked ─────────────────────────────────────────────────
    process:        undefined,
    require:        undefined,
    module:         undefined,
    exports:        undefined,
    __filename:     undefined,
    __dirname:      undefined,
    global:         undefined,
    globalThis:     undefined,
    fetch:          undefined,
    XMLHttpRequest: undefined,
    WebSocket:      undefined,
    Deno:           undefined,
    Bun:            undefined,
  });
}

// ─── Process guard (concurrency-safe) ─────────────────────────────────────────
// Blocks process.exit / process.kill / process.abort while sandboxed code runs.
// Uses reference counting so parallel workers all stay protected — the first
// entering test installs the guards, the last exiting test removes them.
//
// NOTE: We intentionally do NOT strip or replace process.env. The previous
// implementation replaced process.env with {} during async sandbox execution,
// which broke concurrent Express handlers that read env vars between await
// points (JWT verification, AI provider calls, SQLite config, etc.). Since
// Node.js is single-threaded but test execution is async, the event loop
// processes other tasks (including HTTP requests) while page actions await,
// and those tasks would find process.env empty.
//
// The vm sandbox already sets `process: undefined` in its context. The only
// way to reach the host process is via .constructor.constructor('return process')().
// For true env isolation, use worker_threads with `env: {}` (see NEXT_STEPS.md
// S1-02). The current approach blocks destructive operations (exit/kill/abort)
// without breaking the server.

let _envGuardCount = 0;
let _savedExit = null;
let _savedKill = null;
let _savedAbort = null;

/**
 * Execute a function with destructive process methods blocked.
 *
 * Blocks `process.exit()`, `process.kill()`, and `process.abort()` so that
 * sandbox-escaped code cannot crash the server. The vm sandbox already hides
 * `process` from the global scope; these guards are a defense-in-depth layer
 * for the `.constructor.constructor('return process')()` escape path.
 *
 * NOTE: `process.env` is NOT stripped — doing so breaks concurrent server
 * operations (Express handlers, JWT verification, AI calls) that run on the
 * same event loop between await points. For env isolation, use worker_threads
 * with `env: {}`.
 *
 * Concurrency-safe: uses a reference counter so parallel workers (poolMap in
 * testRunner.js) all run with guards installed. The first entering test
 * installs them, the last exiting test restores the originals.
 *
 * @param {Function} fn — async function to execute with process guards
 * @returns {Promise<*>} return value of fn
 */
async function runWithStrippedEnv(fn) {
  if (_envGuardCount === 0) {
    _savedExit = process.exit;
    _savedKill = process.kill;
    _savedAbort = process.abort;
    process.exit = () => { throw new Error("process.exit() is blocked"); };
    process.kill = () => { throw new Error("process.kill() is blocked"); };
    process.abort = () => { throw new Error("process.abort() is blocked"); };
  }
  _envGuardCount++;
  try {
    return await fn();
  } finally {
    _envGuardCount--;
    if (_envGuardCount === 0) {
      process.exit = _savedExit;
      process.kill = _savedKill;
      process.abort = _savedAbort;
      _savedExit = null;
      _savedKill = null;
      _savedAbort = null;
    }
  }
}

/**
 * Compile and execute code inside a vm sandbox with env stripping.
 *
 * @param {string}   code     — The full async IIFE source to execute
 * @param {Object}   exposed  — Objects to inject into the sandbox context
 * @param {string}   [filename] — Virtual filename for stack traces
 * @returns {Promise<*>} The return value of the executed code
 */
async function runInSandbox(code, exposed, filename = "generated-test.js") {
  const ctx = buildSandboxContext(exposed);
  const fn = vm.compileFunction(code, [], {
    parsingContext: ctx,
    filename,
  });
  return await runWithStrippedEnv(() => fn());
}

/**
 * Inject `await __captureStep(N)` calls after each `// Step N:` comment in the
 * test body so we capture a screenshot + timing after each logical step.
 *
 * If the code has no `// Step N:` comments (older tests, manual code), the
 * original code is returned unchanged — the caller falls back to a single
 * end-of-test screenshot.
 *
 * @param {string} code — cleaned test body
 * @returns {string} instrumented code
 */
function injectStepCaptures(code) {
  // Match "// Step N:" with optional trailing text, case-insensitive
  const stepPattern = /^(\s*\/\/\s*Step\s+(\d+)\s*:.*)$/gmi;
  let hasSteps = false;

  // Strategy: after each block of code belonging to a step (i.e. just before
  // the NEXT "// Step N:" comment or end-of-code), insert a capture call.
  // We split on step boundaries and reassemble with capture calls.
  const lines = code.split("\n");
  const result = [];
  let currentStep = null;

  for (const line of lines) {
    const match = line.match(/^\s*\/\/\s*Step\s+(\d+)\s*:/i);
    if (match) {
      // Before starting a new step, capture the previous step (if any)
      if (currentStep !== null) {
        result.push(`      await __captureStep(${currentStep});`);
        hasSteps = true;
      }
      currentStep = parseInt(match[1], 10);
    }
    result.push(line);
  }
  // Capture the last step
  if (currentStep !== null) {
    result.push(`      await __captureStep(${currentStep});`);
    hasSteps = true;
  }

  return hasSteps ? result.join("\n") : code;
}

/**
 * runGeneratedCode(page, context, playwrightCode, expect, healingHints, opts)
 *
 * Dynamically executes the AI-generated test body against the live page.
 * Returns { passed: true, healingEvents: [...], stepCaptures: [...] } or throws.
 *
 * healingHints is an optional map of "action::label" → strategyIndex from
 * previous runs, injected into the runtime helpers so the winning strategy
 * is tried first (adaptive self-healing).
 *
 * @param {Object}   page
 * @param {Object}   context
 * @param {string}   playwrightCode
 * @param {Function} expect
 * @param {Object}   [healingHints]
 * @param {Object}   [opts]
 * @param {Function} [opts.onStepCapture] — async (stepNumber, page) => captureData.
 *   Called after each `// Step N:` block completes. Should return a serialisable
 *   object (e.g. { screenshot, artifactPath }) or null. Errors are swallowed.
 */
export async function runGeneratedCode(page, context, playwrightCode, expect, healingHints, opts = {}) {
  const body = extractTestBody(playwrightCode);
  if (!body) {
    throw new Error("Could not parse test body from generated code");
  }

  const cleaned = repairBrokenStringLiterals(
    applyHealingTransforms(
      patchNetworkIdle(stripPlaywrightImports(body))
    )
  );

  // Inject per-step screenshot capture points
  const instrumented = injectStepCaptures(cleaned);

  const helpers = getSelfHealingHelperCode(healingHints);
  const browserRequestContexts = [];
  let requestContextsDisposed = false;
  let defaultRequestContext = null;

  const __getDefaultRequestContext = async () => {
    if (defaultRequestContext) return defaultRequestContext;
    defaultRequestContext = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    browserRequestContexts.push(defaultRequestContext);
    return defaultRequestContext;
  };

  const __newRequestContext = async (options) => {
    const ctx = await playwright.request.newContext({ ignoreHTTPSErrors: true, ...options });
    browserRequestContexts.push(ctx);
    return ctx;
  };

  const __disposeRequestContexts = async () => {
    if (requestContextsDisposed) return;
    requestContextsDisposed = true;
    for (const ctx of browserRequestContexts) {
      await ctx.dispose().catch(() => {});
    }
  };

  // Hybrid browser tests may call both request.newContext() and request.get/post.
  // Provide a fixture-like shim that supports both patterns.
  const __requestShim = {
    newContext: (...args) => __newRequestContext(...args),
    dispose: () => __disposeRequestContexts(),
  };
  for (const method of ["get", "post", "put", "patch", "delete", "fetch", "head"]) {
    __requestShim[method] = async (...args) => {
      const ctx = await __getDefaultRequestContext();
      return ctx[method](...args);
    };
  }

  // Step capture state — collected by __captureStep inside the sandbox,
  // populated by the onStepCapture callback provided by executeTest.
  const stepCaptures = [];
  const stepTimings = [];
  let lastStepTime = Date.now();

  // The __captureStep function is injected into the sandbox context.
  // It records timing and calls the external onStepCapture callback.
  const __captureStep = async (stepNumber) => {
    const now = Date.now();
    const durationMs = now - lastStepTime;
    stepTimings.push({ step: stepNumber, durationMs, completedAt: now });

    if (opts.onStepCapture) {
      try {
        const capture = await opts.onStepCapture(stepNumber, page);
        if (capture) stepCaptures.push({ step: stepNumber, ...capture });
      } catch { /* swallow — step capture must never fail the test */ }
    }

    // Update lastStepTime AFTER the screenshot so the next step's duration
    // does not include the screenshot overhead from this step (DIF-016).
    lastStepTime = Date.now();
  };

  // Build the code string that will run inside the vm sandbox.
  // The sandbox context provides page, context, expect as globals.
  const code = `
    return (async () => {
      ${helpers}
      // Stubs for Playwright fixtures that some LLMs hallucinate in the function
      // signature but are not valid in our eval context (e.g. 'run', 'browser',
      // 'request'). Defining them as undefined prevents ReferenceError crashes.
      const run = undefined;
      const browser = context?.browser?.() ?? undefined;
      // Hybrid UI+API flows legitimately use request.newContext().
      // Expose a scoped request fixture instead of undefined.
      const request = __requestShim;
      let __testError = null;
      try {
        ${instrumented}
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
  `;

  try {
    const result = await runInSandbox(
      code,
      { page, context, expect, __captureStep, __requestShim },
      "browser-test.js",
    );
    return { passed: true, healingEvents: result?.__healingEvents || [], stepCaptures, stepTimings };
  } catch (err) {
    err.__healingEvents = err.__healingEvents || [];
    err.__stepCaptures = stepCaptures;
    err.__stepTimings = stepTimings;
    throw err;
  } finally {
    await __disposeRequestContexts();
  }
}

/**
 * runApiTestCode(playwrightCode, expect)
 *
 * Executes an API-only test that uses Playwright's `request.newContext()`
 * instead of a browser page. Creates a real APIRequestContext, runs the
 * generated code, and cleans up afterwards.
 *
 * Returns { passed: true, apiLogs } or throws with the error.
 *
 * @param {string} playwrightCode - The AI-generated Playwright test code.
 * @param {Function} expect - Playwright's expect function.
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - When aborted, all Playwright request
 *   contexts are forcibly disposed so the caller (e.g. a timeout race) doesn't
 *   leave HTTP connections lingering in the background.
 */
export async function runApiTestCode(playwrightCode, expect, { signal } = {}) {
  const body = extractTestBody(playwrightCode);
  if (!body) {
    throw new Error("Could not parse test body from generated code");
  }

  const cleaned = repairBrokenStringLiterals(
    stripHallucinatedPageAssertions(
      patchNetworkIdle(stripPlaywrightImports(body))
    )
  );

  // Build the code string. We validate syntax eagerly (before creating the
  // request context) by compiling once with a throwaway context. If the AI
  // generated invalid JS, this throws SyntaxError without leaking an HTTP
  // context. The actual execution happens later with the real request object.
  const apiCode = `
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
  `;

  // Eagerly validate syntax — throws SyntaxError before we allocate HTTP resources.
  vm.compileFunction(apiCode, [], { parsingContext: buildSandboxContext({}) });

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

  // Helper to forcibly dispose all request contexts (used by both normal
  // cleanup and external abort signals).
  async function disposeAllContexts() {
    for (const ctx of subContexts) {
      await ctx.dispose().catch(() => {});
    }
    await request.dispose().catch(() => {});
  }

  // If the caller provides an AbortSignal (e.g. from a timeout race),
  // dispose all contexts immediately when it fires. This ensures that
  // even if fn() is still running in the background, the underlying
  // HTTP connections are torn down promptly.
  let onAbort;
  if (signal) {
    if (signal.aborted) {
      await disposeAllContexts();
      throw signal.reason || new Error("Aborted");
    }
    onAbort = () => { disposeAllContexts(); };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await runInSandbox(apiCode, { request, expect, __apiLogs: apiLogs }, "api-test.js");
    return { passed: true, apiLogs };
  } catch (err) {
    err.__apiLogs = apiLogs;
    throw err;
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    await disposeAllContexts();
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
