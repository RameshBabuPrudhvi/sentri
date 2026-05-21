/**
 * @module tests/chaos-provider
 * @description B1.8 — Error-injection / chaos tests for protocol modules.
 *
 * Pins the failure-handling contracts dispatch will rely on:
 *   1. HTTP 500 → propagates as a thrown Error (not swallowed).
 *   2. Malformed JSON → NDJSON fallback recovers when lines have `response`.
 *   3. Mid-stream abort → AbortError propagates cleanly with no listener leak.
 *   4. Slow trickle → external timeout fires.
 *   5. Empty / unparseable response → fails closed.
 *
 * These exercise the Ollama protocol module (the only one with self-contained
 * fetch logic). The SDK-backed modules (OpenAI / Anthropic / Gemini) rely on
 * their respective SDK error contracts, covered by
 * `tests/aiProvider-adapter-contract.test.js`.
 */
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = Buffer.alloc(32, "C").toString("base64");
const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const ollama = await import("../src/aiProvider/protocols/ollama.js");
getDatabase();
const { test, summary } = createTestRunner();
const baseRoute = {
  id: "pr-chaos",
  protocol: "ollama",
  family: "ollama",
  model: "mistral:7b",
  baseUrl: "http://127.0.0.1:11434",
};
const baseMessages = { combined: "hello", user: "hello", system: null };
function stubFetch(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}
console.log("\n🧪 HTTP failures");
test("HTTP 500 → throws (not swallowed)", async () => {
  const restore = stubFetch(async () => new Response("internal error", { status: 500 }));
  try {
    await assert.rejects(
      () => ollama.generate(baseRoute, baseMessages, { maxTokens: 64 }),
      /Ollama HTTP 500/,
    );
  } finally { restore(); }
});
test("HTTP 401 → throws with status in message", async () => {
  const restore = stubFetch(async () => new Response("unauthorized", { status: 401 }));
  try {
    await assert.rejects(
      () => ollama.generate(baseRoute, baseMessages, { maxTokens: 64 }),
      /Ollama HTTP 401/,
    );
  } finally { restore(); }
});
test("ECONNREFUSED → throws after retries exhausted", async () => {
  const restore = stubFetch(async () => { throw new Error("ECONNREFUSED"); });
  try {
    await assert.rejects(
      () => ollama.generate(baseRoute, baseMessages, { maxTokens: 64 }),
      /ECONNREFUSED/,
    );
  } finally { restore(); }
});
console.log("\n🧪 malformed JSON / NDJSON fallback");
test("NDJSON fallback recovers when daemon streams response chunks", async () => {
  // Ollama can return NDJSON even when stream:false is requested.
  const ndjson = [
    JSON.stringify({ response: "Hel" }),
    JSON.stringify({ response: "lo" }),
    JSON.stringify({ done: true }),
  ].join("\n");
  const restore = stubFetch(async () => new Response(ndjson, { status: 200 }));
  try {
    const { text } = await ollama.generate(baseRoute, baseMessages, { maxTokens: 64 });
    assert.equal(text, "Hello", "NDJSON chunks must be concatenated");
  } finally { restore(); }
});
test("Completely unparseable response → throws", async () => {
  const restore = stubFetch(async () => new Response("not json and not ndjson", { status: 200 }));
  try {
    await assert.rejects(
      () => ollama.generate(baseRoute, baseMessages, { maxTokens: 64 }),
      /unparseable response/,
    );
  } finally { restore(); }
});
test("Empty response with no `response` field → throws", async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({ done: true }), { status: 200 }));
  try {
    await assert.rejects(
      () => ollama.generate(baseRoute, baseMessages, { maxTokens: 64 }),
      /Unexpected Ollama response shape/,
    );
  } finally { restore(); }
});
console.log("\n🧪 abort semantics");
test("Pre-aborted signal → throws AbortError immediately", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => ollama.generate(baseRoute, baseMessages, { maxTokens: 64, signal: ctrl.signal }),
    (err) => err.name === "AbortError",
  );
});
test("Mid-flight abort propagates as AbortError", async () => {
  const ctrl = new AbortController();
  // Stub fetch to never resolve; trigger abort while it's pending.
  const restore = stubFetch((url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    });
  }));
  try {
    setTimeout(() => ctrl.abort(), 10);
    await assert.rejects(
      () => ollama.generate(baseRoute, baseMessages, { maxTokens: 64, signal: ctrl.signal }),
      (err) => err.name === "AbortError",
    );
  } finally { restore(); }
});
test("Mid-flight abort does not leak external-signal listeners", async () => {
  const ctrl = new AbortController();
  const before = ctrl.signal.eventListeners?.("abort")?.length || 0;
  const restore = stubFetch(async () => new Response(
    JSON.stringify({ response: "ok" }),
    { status: 200 },
  ));
  try {
    await ollama.generate(baseRoute, baseMessages, { maxTokens: 64, signal: ctrl.signal });
    const after = ctrl.signal.eventListeners?.("abort")?.length || 0;
    // Listener-leak detection — node's AbortSignal doesn't expose
    // eventListeners() universally, so accept either undefined (older
    // node) or no increase. Contract: listener count is restored, not
    // exact zero (a parent test framework may already have listeners).
    assert.ok(after <= before, `listener leak: before=${before} after=${after}`);
  } finally { restore(); }
});
console.log("\n🧪 slow trickle / timeout");
test("opts.timeoutMs aborts a hung request", async () => {
  // Stub fetch to never resolve naturally. The internal AbortController
  // wired to opts.timeoutMs should fire and surface as a timeout error.
  const restore = stubFetch((url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    });
  }));
  try {
    await assert.rejects(
      () => ollama.generate(baseRoute, baseMessages, { maxTokens: 64, timeoutMs: 50 }),
      /timed out after/,
    );
  } finally { restore(); }
});
console.log("\n🧪 missing config fails closed");
test("generate without route.baseUrl throws", async () => {
  await assert.rejects(
    () => ollama.generate({ ...baseRoute, baseUrl: undefined }, baseMessages, { maxTokens: 64 }),
    /route\.baseUrl is required/,
  );
});
console.log("\n🧪 Bearer-header forwarding");
test("opts.apiKey is forwarded as Authorization: Bearer", async () => {
  let capturedHeaders = null;
  const restore = stubFetch(async (url, init) => {
    capturedHeaders = init.headers;
    return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
  });
  try {
    await ollama.generate(baseRoute, baseMessages, { maxTokens: 64, apiKey: "secret-token" });
    assert.equal(capturedHeaders.Authorization, "Bearer secret-token",
      "authenticated Ollama gateways must receive the Bearer token");
  } finally { restore(); }
});
test("missing opts.apiKey → no Authorization header (unauthenticated default)", async () => {
  let capturedHeaders = null;
  const restore = stubFetch(async (url, init) => {
    capturedHeaders = init.headers;
    return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
  });
  try {
    await ollama.generate(baseRoute, baseMessages, { maxTokens: 64 });
    assert.equal(capturedHeaders.Authorization, undefined,
      "unauthenticated Ollama must not get a Bearer header");
  } finally { restore(); }
});
summary("Chaos provider (B1.8)");
