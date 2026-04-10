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
 * AI-generated code runs inside a vm context that strips `process` from the
 * global scope. However, any injected host object (page, expect, Buffer, etc.)
 * exposes the host's Function constructor via `.constructor.constructor`, which
 * can be used to escape the sandbox:
 *
 *   `page.constructor.constructor('return process')()`
 *
 * Node.js docs explicitly warn: "The vm module is not a security mechanism.
 * Do not use it to run untrusted code."
 *
 * To mitigate this, we strip `process.env` before executing AI-generated code
 * and restore it afterward. This ensures that even if sandbox code reaches the
 * host `process` object, it cannot read API keys or secrets. We also block
 * `process.exit()`, `process.kill()`, and `process.abort()` so escaped code
 * cannot crash the server.
 *
 * For true isolation (e.g. running untrusted plugins), use worker_threads
 * with `env: {}` or a subprocess with a stripped environment.
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

// ─── Env-stripping guard (concurrency-safe) ──────────────────────────────────
// Reference counter: env is stripped while ANY sandbox is running, restored
// only when the last concurrent sandbox finishes. Safe in single-threaded
// Node.js because the counter is incremented/decremented synchronously
// (before/after await), so no two increments can interleave.

let _envGuardCount = 0;
let _savedEnv = null;
let _savedExit = null;
let _savedKill = null;
let _savedAbort = null;

/**
 * Execute a function with process.env temporarily stripped.
 *
 * This is the real security boundary. Even if AI-generated code escapes the
 * vm sandbox via `.constructor.constructor('return process')()`, it will find
 * an empty `process.env` — no API keys, no secrets, no database paths.
 *
 * Concurrency-safe: uses a reference counter so parallel workers (poolMap in
 * testRunner.js) all run with stripped env. The first entering test strips,
 * the last exiting test restores. No interleaving is possible because the
 * counter operations are synchronous (between await points).
 *
 * @param {Function} fn — async function to execute with stripped env
 * @returns {Promise<*>} return value of fn
 */
async function runWithStrippedEnv(fn) {
  if (_envGuardCount === 0) {
    // First test entering — save and strip
    _savedEnv = process.env;
    _savedExit = process.exit;
    _savedKill = process.kill;
    _savedAbort = process.abort;
    process.env = {};
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
      // Last test exiting — restore
      process.env = _savedEnv;
      process.exit = _savedExit;
      process.kill = _savedKill;
      process.abort = _savedAbort;
      _savedEnv = null;
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
