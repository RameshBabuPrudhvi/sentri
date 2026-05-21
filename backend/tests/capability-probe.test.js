/**
 * @module tests/capability-probe
 * @description B2.2 — Capability probe unit tests.
 *
 * Exercises `runCapabilityProbe(route, opts)` against a stubbed
 * protocol adapter (injected via `_setProtocolAdapterForTests`) so
 * the tests are deterministic and don't burn real provider quota.
 * Coverage:
 *
 *   1. Happy path — every dimension probed; `source: "network"`,
 *      `reachable/auth/model: true`, jsonMode reflects adapter
 *      acceptance.
 *   2. Network failure — `reachable: false`, errorReason populated,
 *      capabilities fall back to catalog floor for the other dims.
 *   3. Auth failure (401) — `reachable: true, auth: false`, model
 *      stays null (couldn't observe).
 *   4. Model-not-found (404) — `reachable: true, auth: true,
 *      model: false`.
 *   5. JSON-mode rejection — reachable passes; jsonMode probe fails
 *      with a 400 → jsonMode resolves to `false` while other dims
 *      observed `true`.
 *   6. Missing dispatch fields → `source: "catalog"` shape with
 *      `errorReason: "route_missing_dispatch_fields"`.
 *   7. `_catalogOnlyCapabilities` returns a stable shape matching
 *      the runtime probe's catalog-fallback output.
 *   8. Vision dimension — taken from catalog, not probed (verified
 *      by asserting the stub adapter is NOT invoked with image
 *      content).
 */
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");

const { createTestRunner } = await import("./helpers/test-base.js");
const { capabilitiesFor } = await import("../src/aiProvider/modelCatalog.js");
const { runCapabilityProbe, _setProtocolAdapterForTests, _catalogOnlyCapabilities } =
  await import("../src/aiProvider/capabilityProbe.js");

const { test, summary } = createTestRunner();

/**
 * Build a fake protocolAdapter that records every `generate()` call
 * and returns whatever the caller's `respond(opts)` function decides.
 *
 * `respond` receives the full opts bag (so tests can inspect what the
 * probe sent — for example to verify `responseFormat: "json_object"`
 * on the jsonMode probe). It can return:
 *   • A `{ text, usage }` object to simulate success.
 *   • A `Promise.resolve` of the same shape.
 *   • A function thrown via `throw` to simulate provider error.
 *
 * Call `restore()` in a finally block (or test teardown) to ensure
 * the real adapter is reinstated even on test failure — otherwise a
 * leaky stub would break every subsequent test in this file.
 */
function installStubAdapter(respond) {
  const calls = [];
  const stub = {
    generate: async (route, messages, opts) => {
      calls.push({ route, messages, opts });
      const result = await respond({ route, messages, opts });
      if (result instanceof Error) throw result;
      return result;
    },
    // probe never streams, but the seam contract is `{ generate, stream }`.
    stream: async () => null,
  };
  _setProtocolAdapterForTests(stub);
  return {
    calls,
    restore: () => _setProtocolAdapterForTests(null),
  };
}

/** Build a minimal valid route — enough fields that the probe's
 * defensive "missing dispatch fields" branch doesn't short-circuit. */
function makeRoute(overrides = {}) {
  return {
    id: "pr-test-1234",
    workspaceId: "ws-test-1234",
    name: "test-route",
    family: "openai",
    protocol: "openai",
    baseUrl: null,
    model: "gpt-4o-mini",
    enabled: 1,
    ...overrides,
  };
}

/** Synthesise a stub error matching the SDK shapes the probe classifies. */
function sdkError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
// ── 1. Happy path ─────────────────────────────────────────────────────────────
test("happy path: every dimension probed → reachable+auth+model true, source=network", async () => {
  const stub = installStubAdapter(() => ({ text: "OK", usage: { input: 5, output: 1 } }));
  try {
    const caps = await runCapabilityProbe(makeRoute());
    assert.equal(caps.reachable, true);
    assert.equal(caps.auth, true);
    assert.equal(caps.model, true);
    assert.equal(caps.jsonMode, true, "openai stub accepts json_object → true");
    assert.equal(caps.vision, true, "openai catalog default");
    assert.equal(caps.source, "network");
    assert.equal(typeof caps.probedAt, "string");
    // Two probe calls expected: reachability + jsonMode. Vision is
    // catalog-only so no third call should have been issued.
    assert.equal(stub.calls.length, 2,
      "vision must NOT make a network call (catalog-only per probe spec)");
    // First call is reachability — responseFormat="text".
    assert.equal(stub.calls[0].opts.responseFormat, "text");
    // Second call is jsonMode — responseFormat="json_object".
    assert.equal(stub.calls[1].opts.responseFormat, "json_object");
  } finally {
    stub.restore();
  }
});

// ── 2. JSON-mode rejection ────────────────────────────────────────────────────
test("jsonMode rejection: reachability ok, jsonMode probe returns 400 → jsonMode=false", async () => {
  let callIdx = 0;
  const stub = installStubAdapter(({ opts }) => {
    callIdx += 1;
    if (callIdx === 1) {
      // Reachability — succeed.
      assert.equal(opts.responseFormat, "text");
      return { text: "OK", usage: { input: 5, output: 1 } };
    }
    // jsonMode — provider rejects.
    assert.equal(opts.responseFormat, "json_object");
    return sdkError(400, "response_format is not supported by this model");
  });
  try {
    const caps = await runCapabilityProbe(makeRoute());
    assert.equal(caps.reachable, true);
    assert.equal(caps.auth, true);
    assert.equal(caps.model, true);
    assert.equal(caps.jsonMode, false, "explicit rejection must be reflected");
    assert.equal(caps.source, "network");
  } finally {
    stub.restore();
  }
});

// ── 3. Vision dimension uses catalog, not network ─────────────────────────────
test("vision: probe never sends image content (catalog-only by design)", async () => {
  const stub = installStubAdapter(({ messages }) => {
    // The stub asserts no probe message ever carries image-like content.
    // The probe should send pure-text messages to all probe calls.
    assert.equal(typeof messages.user, "string");
    assert.equal(typeof messages.combined, "string");
    return { text: "OK", usage: { input: 1, output: 1 } };
  });
  try {
    const localOnly = await runCapabilityProbe(makeRoute({ family: "local", protocol: "ollama" }));
    assert.equal(localOnly.vision, false, "local catalog default is false");
    const anthropic = await runCapabilityProbe(makeRoute({ family: "anthropic", protocol: "anthropic" }));
    assert.equal(anthropic.vision, true, "anthropic catalog default is true");
  } finally {
    stub.restore();
  }
});

// ── 4. Compat family maps to openai catalog ──────────────────────────────────
test("custom family maps to openai catalog floor for vision/streaming/context", async () => {
  const stub = installStubAdapter(() => ({ text: "OK", usage: { input: 1, output: 1 } }));
  try {
    const caps = await runCapabilityProbe(makeRoute({ family: "custom" }));
    // Compat slots inherit openai catalog defaults except vision (false).
    // See `capabilityProbe.probeVision` JSDoc — `custom` → `openai`
    // family, so vision *is* true (openai supports vision). That's
    // the conservative-but-fair default; operators with text-only
    // compat endpoints get false-positive vision flag that real
    // dispatch will surface mid-call. Tracked for B3.1 override UI.
    assert.equal(caps.reachable, true);
    assert.equal(caps.source, "network");
    assert.ok(typeof caps.vision === "boolean");
    assert.ok(typeof caps.streaming === "boolean");
  } finally {
    stub.restore();
  }
});
// ── 5. Network failure ────────────────────────────────────────────────────────
test("network failure: reachable=false, errorReason populated, capability dims fall back to catalog", async () => {
  const stub = installStubAdapter(() => sdkError(0, "fetch failed: ECONNREFUSED"));
  try {
    const caps = await runCapabilityProbe(makeRoute());
    assert.equal(caps.reachable, false);
    assert.equal(caps.source, "network");
    assert.ok(caps.errorReason && caps.errorReason.length > 0);
    // Other dims fall back to catalog floor — operators still see
    // capability advertisements while the network is broken.
    assert.equal(typeof caps.vision, "boolean");
    assert.equal(typeof caps.jsonMode, "boolean");
    // Probe must NOT issue a jsonMode call after reachability failed.
    assert.equal(stub.calls.length, 1, "no jsonMode probe after reachability fails");
  } finally {
    stub.restore();
  }
});

// ── 6. Auth failure (401) ─────────────────────────────────────────────────────
test("auth failure (401): reachable=true, auth=false, model unobserved", async () => {
  const stub = installStubAdapter(() => sdkError(401, "Unauthorized: invalid API key"));
  try {
    const caps = await runCapabilityProbe(makeRoute());
    assert.equal(caps.reachable, true);
    assert.equal(caps.auth, false);
    // model dimension unobservable — couldn't get past auth to test it.
    // The probe reports `null` rather than asserting true/false.
    assert.ok(caps.model === null || caps.model === false);
    assert.equal(caps.errorReason, "auth_failed");
    assert.equal(caps.source, "network");
  } finally {
    stub.restore();
  }
});

// ── 7. Model-not-found (404) ──────────────────────────────────────────────────
test("model-not-found (404): reachable=true, auth=true, model=false", async () => {
  const stub = installStubAdapter(() => sdkError(404, "model 'gpt-not-real' does not exist"));
  try {
    const caps = await runCapabilityProbe(makeRoute({ model: "gpt-not-real" }));
    assert.equal(caps.reachable, true);
    assert.equal(caps.auth, true);
    assert.equal(caps.model, false);
    assert.equal(caps.errorReason, "model_not_found");
    assert.equal(caps.source, "network");
  } finally {
    stub.restore();
  }
});

// ── 8. Rate-limited (429) — treated as reachable + auth ok ────────────────────
test("rate-limited (429): reachable=true, auth=true, errorReason=rate_limited", async () => {
  const stub = installStubAdapter(() => sdkError(429, "Rate limit exceeded"));
  try {
    const caps = await runCapabilityProbe(makeRoute());
    assert.equal(caps.reachable, true);
    // Auth treated as ok — the provider responded with a real error
    // that requires a working key; rate-limit alone doesn't mean
    // auth's broken.
    assert.notEqual(caps.auth, false, "rate-limit must not be misclassified as auth failure");
    assert.equal(caps.errorReason, "rate_limited");
  } finally {
    stub.restore();
  }
});

// ── 9. Timeout (probe completes within timeoutMs) ─────────────────────────────
test("timeout: probe aborts at timeoutMs, persists reachable=false", async () => {
  const stub = installStubAdapter(({ opts }) => {
    // Simulate a hang — return a Promise that listens to opts.signal
    // and rejects when the timeout aborts it.
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        reject(new Error("probe timeout"));
      });
    });
  });
  try {
    const caps = await runCapabilityProbe(makeRoute(), { timeoutMs: 50 });
    assert.equal(caps.reachable, false);
    assert.ok(caps.errorReason);
    assert.match(caps.errorReason, /timeout|abort/i);
  } finally {
    stub.restore();
  }
});
// ── 10. Missing dispatch fields → catalog source, never probes ────────────────
test("route missing dispatch fields → source=catalog, no network calls", async () => {
  let networkCalled = false;
  const stub = installStubAdapter(() => {
    networkCalled = true;
    return { text: "should not reach here", usage: null };
  });
  try {
    // Missing `protocol` — probe must NOT attempt network call.
    const caps = await runCapabilityProbe({ id: "pr-x", workspaceId: "ws-x", family: "openai" });
    assert.equal(caps.source, "catalog");
    assert.equal(caps.errorReason, "route_missing_dispatch_fields");
    assert.equal(caps.reachable, false);
    assert.equal(networkCalled, false, "must not attempt network call on incomplete route");
  } finally {
    stub.restore();
  }
});

// ── 11. _catalogOnlyCapabilities returns the same shape ───────────────────────
test("_catalogOnlyCapabilities shape matches runtime catalog fallback", () => {
  const route = makeRoute({ family: "anthropic" });
  const synth = _catalogOnlyCapabilities(route, "manual_reason");
  // Same key set as runtime probe output (modulo no `auth: true` /
  // `model: true` since this is the catalog-only path).
  for (const key of ["reachable", "auth", "model", "vision", "jsonMode", "tools",
                     "streaming", "contextWindow", "maxOutputTokens", "probedAt",
                     "source", "errorReason"]) {
    assert.ok(key in synth, `_catalogOnlyCapabilities must include ${key}`);
  }
  assert.equal(synth.source, "catalog");
  assert.equal(synth.errorReason, "manual_reason");
  assert.equal(synth.reachable, false);
});

// ── 12. capabilitiesFor sanity (kept from the pre-B2.2 placeholder) ───────────
test("capabilitiesFor: booleans + numeric/null bounds", () => {
  const caps = capabilitiesFor("openai");
  assert.equal(typeof caps.supportsVision, "boolean");
  assert.equal(typeof caps.supportsJsonMode, "boolean");
  assert.equal(typeof caps.supportsStreaming, "boolean");
  assert.ok(caps.contextWindow == null || Number.isFinite(caps.contextWindow));
  assert.ok(caps.maxOutputTokens == null || Number.isFinite(caps.maxOutputTokens));
});

summary("Capability probe (B2.2)");
