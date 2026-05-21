/**
 * @module tests/no-code-edits-contract
 * @description B4.4 — Pins the central guarantee of the AI provider
 *   routes roadmap: **an operator can add a new vendor with zero code
 *   edits**. Registers a `provider_routes` row whose `family` is the
 *   catch-all `"custom"` enum, pointing at a mock HTTP server that
 *   speaks the OpenAI chat-completions wire format, then asserts that
 *   `generateText()` reaches the mock — meaning the SDK was driven by
 *   `route.protocol` + `route.baseUrl` + `route.apiKey` + `route.model`,
 *   NOT by a hardcoded `provider`→adapter / `provider`→env-key table.
 *
 * ## Why this is the highest-leverage test in the suite
 *
 * The roadmap's "Definition of done" item 1 is literally:
 *
 *   > Add a new vendor in the Settings UI by entering
 *   > {name, url, model, apiKey} — zero code edits
 *
 * If this test passes, that guarantee holds. If it fails, dispatch
 * still has a hardcoded family enum somewhere in the call chain.
 *
 * ## History
 *
 * Pre-B4.1, this test was scaffolded but **unregistered** because
 * `_callProviderUnsafe` dispatched everything through
 * `adapterFor(provider)` + `buildAdapterOpts(provider, …)`, both keyed
 * off `provider` (derived from `route.family`). For a `family: "custom"`
 * route the legacy path either threw `Unknown provider: custom` or read
 * `process.env.OPENAI_API_KEY` and ignored the route's own
 * `apiKey` / `baseUrl` / `model`.
 *
 * B4.1 added a route-id discriminator: real routes (`route.id` starts
 * with `"pr-"`) now flow through `protocolAdapter.generate(route, …)`
 * keyed on `route.protocol`, while transient env-default routes
 * (`route.id` starts with `"provider:"`) keep the legacy path. With
 * that change this test passes and is now registered in
 * `backend/tests/run-tests.js` so it guards the contract permanently
 * against regression.
 *
 * ## Test design notes
 *
 *   • **Mock HTTP server, not nock** — mirrors `openai-compat-provider.test.js`
 *     so the test exercises the full SDK + fetch stack.
 *   • **`ALLOW_PRIVATE_URLS=true`** — lets the SSRF guard accept the
 *     loopback `baseUrl`. Same pattern as the compat-provider test.
 *   • **Authorization header assertion** — proves the route's stored
 *     `apiKey` (encrypted at rest, decrypted via `secrets.js`) actually
 *     reached the SDK. Without this, a green dispatch could still mean
 *     the SDK used an env key by accident.
 *   • **Env keys explicitly cleared** — a regression in dispatch must
 *     NOT be able to silently succeed via OpenAI/Anthropic/Google env
 *     keys and mask the real bug.
 *   • **Family is `"custom"`, not `"openai"`** — the whole point is
 *     dispatching a family the legacy switch has never heard of.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 9).toString("base64");
// Speed up retries so a single dispatch failure doesn't burn 30s of
// backoff before the test fails. Mirrors openai-compat-provider.test.js.
process.env.LLM_MAX_RETRIES = "0";
process.env.LLM_BASE_DELAY_MS = "1";

const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
const agentConfigRepo = await import("../src/database/repositories/agentConfigRepo.js");
const providerRouteRepo = await import("../src/database/repositories/providerRouteRepo.js");
const secrets = await import("../src/aiProvider/secrets.js");
const ai = await import("../src/aiProvider.js");

getDatabase();
ensureDefaultWorkspaces();

const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();

/**
 * Seed a workspace + owner user. FK chain on `provider_routes.workspaceId`
 * requires both. Mirrors the helper in `agent-dispatch.test.js`.
 */
function seedWorkspace() {
  const db = getDatabase();
  const userId = `usr-${randomUUID().slice(0, 8)}`;
  const wsId = `ws-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, `Test ${userId}`, `${userId}@test.local`, "x", now(), now());
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(wsId, `ws-${wsId}`, wsId, userId, now(), now());
  return wsId;
}

/**
 * Stand up a loopback HTTP server that speaks the OpenAI chat-completions
 * wire format. Records every request so the test can assert on the
 * Authorization header (proves the route's stored key reached the SDK)
 * and the URL path (proves the route's stored baseUrl reached the SDK).
 *
 * `close` MUST be awaited in a finally block to avoid leaking the
 * listener past the test.
 */
async function startMockOpenAiServer() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization || null,
        body: (() => { try { return JSON.parse(body); } catch { return null; } })(),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok-from-mock-vendor" } }],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Save + clear every cloud-default env key so a regression in dispatch
 * can't accidentally "succeed" via OpenAI/Anthropic/Google env keys and
 * mask the real bug. Returns a `restore()` to call in finally.
 */
function isolateCloudEnvKeys() {
  const KEYS = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY", "DEMO_GOOGLE_API_KEY",
  ];
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
    }
  };
}

// ── 1. Custom-family route dispatches via route.protocol ─────────────────────

test("dispatch reaches a custom-family route with operator-supplied apiKey + baseUrl + model", async () => {
  process.env.ALLOW_PRIVATE_URLS = "true";
  const mock = await startMockOpenAiServer();
  const restoreEnv = isolateCloudEnvKeys();
  try {
    const wsId = seedWorkspace();

    // The vendor key the operator would paste into Settings → Provider
    // Routes. Encrypted on save by `providerRouteRepo.upsert` via
    // `secrets.encryptKey`; decrypted at dispatch time via
    // `secrets.getDecryptedKey(workspaceId, routeId)`. The test asserts
    // this exact byte sequence reaches the mock's Authorization header.
    const vendorKey = "vendor-test-key-no-code-edits-12345"; // gitleaks:allow
    const enc = secrets.encryptKey(vendorKey);

    // Register with `family: "custom"` — the catch-all enum from
    // migration 035. The B4.1 dispatch path keys off `route.protocol`
    // ("openai" wire format) NOT `route.family`, so dispatch must reach
    // the mock regardless of the family string being one the legacy
    // `adapterFor`/`buildAdapterOpts` switch has never heard of.
    const route = providerRouteRepo.upsert({
      workspaceId: wsId,
      userId: null,
      name: "no-code-edits-mock-vendor",
      family: "custom",
      protocol: "openai",
      baseUrl: mock.baseUrl,
      model: "mock-vendor-model-v1",
      apiKeyEncrypted: enc.ciphertext,
      apiKeyNonce: enc.nonce,
      apiKeyLastFour: enc.lastFour,
      enabled: true,
      // Suppress auto-probe — its network call to the mock would pollute
      // the `calls` array we assert on below.
      skipAutoProbe: true,
    });
    assert.ok(route?.id?.startsWith("pr-"), "route must be persisted with an id");

    // Pin to planner so `resolveRoute` returns it. Without an
    // agent_configs row, dispatch falls back to env-default detection.
    agentConfigRepo.upsert({
      id: `cfg-${randomUUID().slice(0, 8)}`,
      workspaceId: wsId,
      role: "planner",
      routeId: route.id,
      temperature: 0,
      createdAt: now(),
      updatedAt: now(),
    });

    const out = await ai.generateText("hello vendor", {
      workspaceId: wsId,
      agentRole: "planner",
      responseFormat: "text",
    });
    assert.equal(out, "ok-from-mock-vendor",
      "dispatch must return the mock vendor's response — proves the route was actually called");

    // ── Contract assertions ────────────────────────────────────────────
    // (1) Exactly one call landed on the mock — no retries, no fan-out.
    assert.equal(mock.calls.length, 1,
      `mock vendor must be called exactly once; got ${mock.calls.length} calls`);
    const call = mock.calls[0];

    // (2) Authorization header carries the operator-supplied key. This
    //     is THE key assertion: a green dispatch via env keys would
    //     fail this check because env keys never matched `vendorKey`.
    assert.ok(call.authorization?.includes(vendorKey),
      `Authorization header must carry the route's stored apiKey; got: ${call.authorization}`);

    // (3) URL path lands under the route's baseUrl. The OpenAI SDK
    //     appends `/chat/completions` to the configured baseURL, so the
    //     mock receives `/v1/chat/completions` — proves baseUrl flowed
    //     through, not the SDK default `https://api.openai.com`.
    assert.match(call.url, /\/v1\/chat\/completions$/,
      `request URL must land under route.baseUrl/v1; got: ${call.url}`);

    // (4) Request body carries the route's model id. A regression that
    //     read `MODEL_PRICING` defaults or the openai-family default
    //     model would send a different model string here.
    assert.equal(call.body?.model, "mock-vendor-model-v1",
      "request body must carry the route's stored model id");
  } finally {
    restoreEnv();
    await mock.close();
    delete process.env.ALLOW_PRIVATE_URLS;
  }
});

summary("No-code-edits contract (B4.4)");
