/**
 * @module tests/protocol-adapter-opts
 * @description PR #29 regression — `buildOpts` MUST forward every field
 * a downstream protocol module reads.
 *
 * The keystone bug this PR shipped + then fixed: `buildOpts` enumerates
 * the forwarded field set, and the initial PR-#29 commit added
 * `maxRetries` + `attemptTimeoutMs` to capability probes WITHOUT adding
 * them to `buildOpts`. The fields silently dropped between
 * `protocolAdapter.generate` and `protocols/openai.js`, so every probe
 * still burned the legacy 3-retry × 30s-backoff (~113s) chain instead of
 * the intended ~15s fast-fail. A future refactor that re-enumerates the
 * forwarded set could trivially re-introduce the same bug — this test
 * pins the contract so it surfaces in CI rather than as a 113s probe
 * latency operator complaint.
 *
 * Coverage:
 *   1. Probe fast-fail knobs (`maxRetries` + `attemptTimeoutMs`) round-trip
 *      end-to-end through `buildOpts` with the operator-supplied values.
 *   2. Pre-existing fields stay present (regression guard for someone
 *      "cleaning up" the list and dropping `timeoutMs` / `maxPredict`).
 *   3. `buildOpts` doesn't add stray fields the protocol modules don't
 *      expect (frozen contract — no leakage of caller-supplied internals).
 */
import assert from "node:assert/strict";

const { _buildOptsForTests } = await import(
  "../src/aiProvider/adapters/protocolAdapter.js"
);

console.log("\n🧪 protocolAdapter.buildOpts — forwarded-field contract");

// Synthetic route — `_buildOptsForTests` skips the SQLite-backed
// `secrets.getDecryptedKey` lookup when `workspaceId` / `id` are missing,
// so we don't need a live DB. Test focuses on the field-forwarding
// shape, not the secret-resolution path (which has its own coverage in
// `secrets.test.js`).
const route = { protocol: "openai", id: null, workspaceId: null };

// ── 1. Probe fast-fail knobs forward through buildOpts ────────────────────────
{
  const opts = _buildOptsForTests(route, {
    maxRetries: 0,
    attemptTimeoutMs: 15_000,
  });
  assert.equal(
    opts.maxRetries,
    0,
    "maxRetries: 0 must round-trip — capability probes set this so a bad-key probe fast-fails instead of burning 3 retries × 30s backoff",
  );
  assert.equal(
    opts.attemptTimeoutMs,
    15_000,
    "attemptTimeoutMs must round-trip — protocols/openai.js reads this to override the 120s CLOUD_TIMEOUT_MS for probes",
  );
  console.log("  ✓ maxRetries + attemptTimeoutMs forward through buildOpts");
}

// Truthy-coercion sanity — explicitly set 0 must NOT be coerced to undefined.
// `Number.isFinite(opts.maxRetries) ? opts.maxRetries : MAX_RETRIES` in
// `retry.js` only honours 0 if the field is set; a `??` fallback or a
// `||` collapse to default would silently turn 0 into 3 retries.
{
  const opts = _buildOptsForTests(route, { maxRetries: 0 });
  assert.equal(
    opts.maxRetries,
    0,
    "maxRetries: 0 must survive — falsy-coercion would turn fast-fail back into 3 retries",
  );
  // The field must be set (===), not just === undefined; downstream
  // `Number.isFinite(opts.maxRetries) ? ... : MAX_RETRIES` cares.
  assert.ok(
    "maxRetries" in opts,
    "maxRetries key must be present even when value is 0",
  );
  console.log("  ✓ maxRetries: 0 survives without falsy-coercion to default");
}

// ── 2. Pre-existing forwarded fields stay present ─────────────────────────────
// Regression guard: someone "tidying up" buildOpts could drop a field
// the protocol modules silently rely on. This pins the full set.
{
  const opts = _buildOptsForTests(route, {
    apiKey: "test-key",
    maxTokens: 1024,
    signal: { aborted: false },
    responseFormat: "json_object",
    defaultHeaders: { "X-Test": "1" },
    guardedFetch: () => null,
    onToken: () => {},
    timeoutMs: 30_000,
    maxPredict: 256,
    maxRetries: 2,
    attemptTimeoutMs: 5_000,
  });
  // Every field a protocol module reads MUST be present in the forwarded
  // bag. Sourced from `protocols/openai.js` + `anthropic.js` + `gemini.js`
  // + `ollama.js` consumers as of PR #29 head. Adding a new opts field
  // to a protocol module without adding it here is the bug shape this
  // test catches.
  const requiredKeys = [
    "apiKey",
    "maxTokens",
    "signal",
    "useJson",
    "responseFormat",
    "defaultHeaders",
    "guardedFetch",
    "onToken",
    "timeoutMs",
    "maxPredict",
    "maxRetries",
    "attemptTimeoutMs",
  ];
  for (const key of requiredKeys) {
    assert.ok(
      key in opts,
      `buildOpts must forward "${key}" — protocol modules read it`,
    );
  }
  // useJson is derived (not forwarded), so we check derivation logic too:
  // `responseFormat: "json_object"` → `useJson: true`.
  assert.equal(
    opts.useJson,
    true,
    "useJson derives from responseFormat !== 'text'",
  );
  console.log(`  ✓ all ${requiredKeys.length} forwarded fields present`);
}

// `responseFormat: "text"` → `useJson: false` (the only branch that
// flips). Pre-existing contract; codified here so a refactor of the
// derivation can't silently break OpenAI text-mode dispatch.
{
  const opts = _buildOptsForTests(route, { responseFormat: "text" });
  assert.equal(opts.useJson, false, "responseFormat: 'text' → useJson: false");
  console.log("  ✓ responseFormat='text' correctly flips useJson to false");
}

// ── 3. No surprise leakage — buildOpts shouldn't widen its surface ────────────
// If a future "spread the whole callerOpts" refactor lands, this test
// fails loudly so the reviewer knows the contract changed. Better to
// fail-closed than to silently leak caller-internals (e.g. test scaffolding,
// per-call observability hooks) into the protocol module's surface.
{
  const opts = _buildOptsForTests(route, {
    // A field NO protocol module reads — must not appear on the output.
    __testInternalScratchpad: "leakage canary",
    maxRetries: 0,
  });
  assert.equal(
    opts.__testInternalScratchpad,
    undefined,
    "buildOpts must NOT spread arbitrary callerOpts — protocol modules see only the documented surface",
  );
  console.log("  ✓ buildOpts does not leak undocumented caller fields");
}

console.log("\n✅ protocolAdapter.buildOpts contract — all checks passed");
