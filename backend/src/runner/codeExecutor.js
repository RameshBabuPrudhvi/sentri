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
 * AI-generated code is executed via `vm.compileFunction()` inside a sandbox
 * context that only exposes the specific objects the test needs (page, context,
 * expect, etc.) plus safe JS built-ins. Dangerous APIs are explicitly blocked:
 *   - `process`     — env vars, exit, spawn
 *   - `require`     — arbitrary module loading
 *   - `import()`    — dynamic ESM imports
 *   - `global` / `globalThis` — escape to the real global scope
 *   - `fs`, `child_process`, `net`, `http`, etc. — not available
 *
 * This prevents prompt-injection payloads in tested page content from causing
 * the LLM to emit code that reads API keys, accesses the filesystem, or makes
 * outbound network calls from the server process.
 *
 * Exports:
 *   runGeneratedCode(page, context, playwrightCode, expect, healingHints)
 *   runApiTestCode(playwrightCode, expect, { signal? })
 *   getExpect()
 */

import vm from "vm";
import { extractTestBody, patchNetworkIdle, stripPlaywrightImports, stripHallucinatedPageAssertions, repairBrokenStringLiterals } from "./codeParsing.js";
import { getSelfHealingHelperCode, applyHealingTransforms } from "../selfHealing.js";
import playwright from "playwright";

// ─── Sandbox helpers ──────────────────────────────────────────────────────────

/**
 * Build a restricted global context for vm.compileFunction().
 * Only safe JS built-ins and the caller-provided objects are available.
 * Dangerous APIs (process, require, import, fs, etc.) are explicitly undefined.
 *
 * @param {Object} exposed — caller-provided objects to inject (e.g. page, context, expect)
 * @returns {Object} A vm context object
 */
function buildSandboxContext(exposed) {
  const ctx = vm.createContext({
    // ── Caller-provided objects (Playwright page, context, expect, etc.) ────
    ...exposed,

    // ── Safe JS built-ins required by generated Playwright code ─────────────
    console:        Object.freeze({ log: console.log, warn: console.warn, error: console.error, info: console.info }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    URIError,
    AggregateError,
    DOMException,
    JSON,
    Date,
    Math,
    RegExp,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Symbol,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    ArrayBuffer,
    SharedArrayBuffer,
    DataView,
    BigInt,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob:           typeof atob === "function" ? atob : undefined,
    btoa:           typeof btoa === "function" ? btoa : undefined,
    structuredClone: typeof structuredClone === "function" ? structuredClone : undefined,
    Buffer,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    undefined,
    NaN,
    Infinity,

    // ── Explicitly blocked — prevent escape from sandbox ────────────────────
    process:        undefined,
    require:        undefined,
    module:         undefined,
    exports:        undefined,
    __filename:     undefined,
    __dirname:      undefined,
    global:         undefined,
    globalThis:     undefined,
    fetch:          undefined,   // block outbound HTTP from generated code
    XMLHttpRequest: undefined,
    WebSocket:      undefined,
    Deno:           undefined,
    Bun:            undefined,
  });

  return ctx;
}

/**
 * Compile and execute code inside a vm sandbox.
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
  return await fn();
}

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
  `;

  try {
    const result = await runInSandbox(code, { page, context, expect }, "browser-test.js");
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
