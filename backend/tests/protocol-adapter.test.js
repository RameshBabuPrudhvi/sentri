/**
 * @module tests/protocol-adapter
 * @description B1.5 — protocolAdapter routing + streaming-parity contract.
 *
 * Pins the dispatcher contracts that don't require live SDK calls:
 *   1. Unknown `route.protocol` throws (fails closed).
 *   2. Missing `route.protocol` throws.
 *   3. `stream()` requires `opts.onToken`.
 *   4. `generate()` resolves the decrypted key via `secrets.getDecryptedKey`
 *      (synthetic routes with no workspaceId/id skip the key lookup cleanly).
 *
 * The SDK round-trip behaviour for each protocol module is exercised by
 * the existing legacy adapter contract tests (`tests/aiProvider-adapter-contract.test.js`)
 * which already cover anthropic / openai / google / ollama against mock
 * SDKs. This file pins the NEW surface — the protocolAdapter switch + the
 * streaming-parity fallback — without re-mocking every SDK.
 */
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = Buffer.alloc(32, "P").toString("base64");
const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const protocolAdapter = await import("../src/aiProvider/adapters/protocolAdapter.js");
getDatabase();
const { test, summary } = createTestRunner();
console.log("\n🧪 protocolAdapter routing");
test("generate throws on missing route.protocol", async () => {
  await assert.rejects(
    () => protocolAdapter.generate({ id: "pr-x" }, { user: "hi" }, {}),
    /route\.protocol is required/,
  );
});
test("generate throws on unknown route.protocol (fails closed)", async () => {
  await assert.rejects(
    () => protocolAdapter.generate({ protocol: "telepathy", id: "pr-x" }, { user: "hi" }, {}),
    /Unknown route protocol/,
  );
});
test("stream throws when opts.onToken is missing", async () => {
  await assert.rejects(
    () => protocolAdapter.stream(
      { protocol: "openai", id: "pr-x" },
      { user: "hi" },
      {},
    ),
    /onToken is required/,
  );
});
test("stream throws on unknown route.protocol", async () => {
  await assert.rejects(
    () => protocolAdapter.stream(
      { protocol: "telepathy", id: "pr-x" },
      { user: "hi" },
      { onToken: () => {} },
    ),
    /Unknown route protocol/,
  );
});
console.log("\n🧪 streaming-parity fallback");
test("ollama stream returns null → dispatcher falls back to generate + synthesises onToken", async () => {
  // Mock the underlying ollama protocol module by spoofing fetch. Ollama's
  // stream() unconditionally returns null (legacy parity), so the
  // dispatcher's fallback path activates and the result of generate() is
  // emitted as a single onToken call. We assert ONLY the fallback shape;
  // the HTTP round-trip is covered by the legacy ollama adapter test.
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ response: "synthetic-output" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  const tokens = [];
  try {
    const result = await protocolAdapter.stream(
      { id: "pr-fake", protocol: "ollama", model: "mistral:7b", baseUrl: "http://127.0.0.1:11434" },
      { combined: "hello", user: "hello", system: null },
      { onToken: (t) => tokens.push(t), maxTokens: 64 },
    );
    assert.equal(tokens.length, 1, "ollama fallback emits exactly one synthetic token");
    assert.equal(tokens[0], "synthetic-output");
    assert.equal(result.text, "synthetic-output");
  } finally {
    global.fetch = originalFetch;
  }
});
test("gemini stream() native return is null (fallback contract)", async () => {
  const gemini = await import("../src/aiProvider/protocols/gemini.js");
  assert.equal(await gemini.stream(), null,
    "gemini protocol module signals fallback by returning null from stream()");
});
test("ollama stream() native return is null (fallback contract)", async () => {
  const ollama = await import("../src/aiProvider/protocols/ollama.js");
  assert.equal(await ollama.stream(), null,
    "ollama protocol module signals fallback by returning null from stream()");
});
console.log("\n🧪 protocol modules export the contract surface");
test("every protocol module exports generate + stream", async () => {
  const modules = await Promise.all([
    import("../src/aiProvider/protocols/openai.js"),
    import("../src/aiProvider/protocols/anthropic.js"),
    import("../src/aiProvider/protocols/gemini.js"),
    import("../src/aiProvider/protocols/ollama.js"),
  ]);
  for (const m of modules) {
    assert.equal(typeof m.generate, "function", "generate() is required by the contract");
    assert.equal(typeof m.stream, "function", "stream() is required by the contract");
  }
});
summary("Protocol adapter (B1.5)");
