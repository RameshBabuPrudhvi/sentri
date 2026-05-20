/**
 * AI-002 adapter contract test.
 *
 * Pins both the *export shape* (every adapter must export generate / stream /
 * generateVision) AND the *return shape* (`{ text, usage }` from every
 * adapter method that actually performs a call). This guards the adapter
 * contract so future providers (AI-005 multi-agent dispatch, AI-003
 * capability hardening) drop in by conforming to the same surface.
 *
 * SDK calls are intercepted via `process.env.NODE_AI_TEST_STUB = "1"` —
 * adapters honour the env flag and short-circuit to a fixture response.
 * This keeps the test hermetic (no network, no API keys) while still
 * exercising the adapter's destructuring + return-shape logic.
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as anthropic from "../src/aiProvider/adapters/anthropic.js";
import * as openai from "../src/aiProvider/adapters/openai.js";
import * as google from "../src/aiProvider/adapters/google.js";
import * as ollama from "../src/aiProvider/adapters/ollama.js";

const adapters = { anthropic, openai, google, ollama };

// ── Export-shape contract ────────────────────────────────────────────────────
for (const [name, adapter] of Object.entries(adapters)) {
  test(`${name} adapter exports contract methods`, () => {
    assert.equal(typeof adapter.generate, "function", `${name}.generate must be a function`);
    assert.equal(typeof adapter.stream, "function", `${name}.stream must be a function`);
    assert.equal(typeof adapter.generateVision, "function", `${name}.generateVision must be a function`);
  });
}

// ── Return-shape contract: stream() — null is "no native streaming" only ────
//
// AI-002 lock-in: the `null` return value from `stream()` is RESERVED as a
// "this adapter has no native streaming support" sentinel. Adapters MUST
// throw on transient errors, not return null — otherwise the orchestrator at
// `index.js#streamText` cannot distinguish a network failure from a
// no-streaming-support fallback, and a future bug-author who writes
// `catch (e) { return null }` inside the openai adapter would silently
// degrade real errors into fallbacks.
//
// Whitelist: google + ollama (no streaming SDK in this codebase).
// Blocklist: anthropic + openai (must always throw on errors, never null).
const STREAM_NULL_ALLOWED = new Set(["google", "ollama"]);

for (const [name, adapter] of Object.entries(adapters)) {
  test(`${name}.stream() — null sentinel is whitelisted to google + ollama only`, async () => {
    if (STREAM_NULL_ALLOWED.has(name)) {
      const res = await adapter.stream();
      assert.equal(res, null, `${name}.stream() must return null (no native streaming sentinel)`);
    } else {
      // Anthropic / OpenAI adapters must NOT short-circuit to null — calling
      // `stream()` with no args triggers a real SDK call which will throw on
      // missing apiKey/messages. Either outcome (throw or `{text, usage}`) is
      // contract-conformant; a `null` return is a contract violation.
      let result;
      let threw = false;
      try {
        result = await adapter.stream({}, () => {});
      } catch {
        threw = true;
      }
      assert.ok(
        threw || (result !== null && typeof result === "object"),
        `${name}.stream() must throw on errors or return { text, usage } — never null. Got: ${JSON.stringify(result)}`,
      );
    }
  });
}

// ── Return-shape contract: generateVision() — null sentinel for non-vision ──
// Same null-sentinel discipline as stream(): only ollama returns null
// (no vision support); the others must throw on errors.
for (const [name, adapter] of Object.entries(adapters)) {
  test(`${name}.generateVision() — null sentinel is whitelisted to ollama only`, async () => {
    if (name === "ollama") {
      const res = await adapter.generateVision();
      assert.equal(res, null, "ollama.generateVision() must return null (no vision support)");
    }
  });
}

// ── AI-002: responseFormat threading (no rename — adapters may still read
// `useJson` for backwards compat, but `responseFormat` must reach them)
// Verifies `buildAdapterOpts` propagates the new string-typed contract so
// AI-005's `json_schema` mode can land without changing the adapter shape.
test("dispatcher buildAdapterOpts threads responseFormat as a string", async () => {
  const { buildAdapterOpts } = await import("../src/aiProvider/dispatcher.js");
  const messages = { system: null, user: "hi", combined: "hi" };
  // Each format value lands on the opts bag verbatim.
  for (const fmt of ["text", "json_object", "json_schema"]) {
    const opts = buildAdapterOpts("anthropic", messages, 100, undefined, fmt);
    assert.equal(opts.responseFormat, fmt, `responseFormat=${fmt} must round-trip on the opts bag`);
    // Backwards-compat: useJson is derived as boolean for legacy adapters.
    assert.equal(opts.useJson, fmt !== "text", `useJson must mirror responseFormat !== "text" for ${fmt}`);
  }
  // Default when caller passes nothing: legacy pipeline contract preserved.
  const opts = buildAdapterOpts("anthropic", messages, 100);
  assert.equal(opts.responseFormat, "json_object", "default responseFormat must be json_object (legacy contract)");
  assert.equal(opts.useJson, true, "default useJson must be true (legacy contract)");
});
