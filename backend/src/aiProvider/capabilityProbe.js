/**
 * @module aiProvider/capabilityProbe
 * @description B2.2 — Real network probe for `provider_routes` capabilities.
 *
 * Sends a tiny no-op request through `protocolAdapter.generate()` to
 * the route's actual endpoint with the route's decrypted key, observes
 * what the provider accepts, and returns a `capabilities` payload
 * suitable for `provider_routes.capabilities` JSON column.
 *
 * ## Why a real probe (not a catalog copy)
 *
 * Three downstream contracts depend on probe fidelity:
 *
 *   1. **B3.1 Settings UI "Test" button** — must show green/red based
 *      on whether the route actually works, not whether the catalog
 *      *thinks* it should.
 *   2. **B3.6 key rotation** — "rejects on probe fail" gate. A
 *      catalog-only probe can't fail, so the gate is theatre.
 *   3. **B4.4 secrets-rotation E2E** — "verify old key fails, new key
 *      works". A catalog probe would pass on both keys, masking the
 *      regression.
 *
 * Catalog defaults (from `modelCatalog.capabilitiesFor`) are still
 * carried as the **floor** — for context-window / max-output-tokens
 * which can't be cheaply probed without burning tokens. The probe
 * upgrades reachable / auth / model / vision / jsonMode / streaming
 * with first-hand evidence and tags `source: "network"` so operators
 * can distinguish probed-and-confirmed from catalog-default in the UI.
 *
 * ## Failure semantics
 *
 *   • Auth failure (401/403) → `{ reachable: true, auth: false, ... }`
 *   • Model not found (404 / "model not found" / "no such model") →
 *     `{ reachable: true, auth: true, model: false, ... }`
 *   • Network/SSRF/timeout → `{ reachable: false, errorReason: "..." }`
 *   • Capability rejection (400 with "vision not supported", etc.) →
 *     leave that one capability `false`, others stay observed.
 *
 * Probe never throws — every failure path returns a `capabilities`
 * object with `reachable: false` (or the relevant flag) and a string
 * `errorReason`. The repo + endpoint layers persist whatever comes
 * back; the operator sees the truth.
 *
 * ## Auto-run on upsert
 *
 * Roadmap B2.2 calls for "auto-run on route upsert; persist to
 * `provider_routes.capabilities`". This module exposes
 * `runCapabilityProbe(route, decryptedApiKey)` so the upcoming B3.3
 * Settings POST/PUT routes can chain `repo.upsert()` →
 * `runCapabilityProbe()` → `repo.upsert({ ..., capabilities })` in a
 * single user-visible save. The B2.1 backfill script deliberately
 * skips auto-probe (inherited global keys may not work in every
 * workspace, and the script is offline / no-network by contract).
 */
import * as defaultProtocolAdapter from "./adapters/protocolAdapter.js";
import { capabilitiesFor } from "./modelCatalog.js";
import { formatLogLine } from "../utils/logFormatter.js";

// Probe timeout — capability probes (`/settings/ai-providers/:id/probe` and
// the auto-probe-on-upsert in providerRouteRepo.upsert) abort after this
// many ms. Defaults to 30s, overridable via `AI_PROBE_TIMEOUT_MS` env var
// for deployments that depend on slow free-tier providers (OpenRouter
// `:free` models, Gemini free tier can queue 30–90s during peak load).
// Clamped to a sane [1s, 5min] window so a typo in `.env` can't disable
// timeouts entirely or set a sub-second value that aborts before TLS
// handshake completes.
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AI_PROBE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 30_000;
  return Math.min(Math.max(raw, 1_000), 300_000);
})();

// ── Test seam ─────────────────────────────────────────────────────────────────
// `protocolAdapter` is held by mutable reference rather than a top-level
// `import` binding so unit tests can swap it for a fake adapter that
// records calls + returns canned responses, without spinning up the
// real protocol modules (which would need real API keys to dispatch).
// Production code never calls `_setProtocolAdapterForTests` — the
// default value resolves to the real module on import.
let protocolAdapter = defaultProtocolAdapter;

/**
 * Test-only seam: substitute the protocol adapter the probe uses for
 * its network calls. Call with `null` (or no argument) to restore the
 * production adapter. NEVER call from product code — a misuse here
 * would silently re-route every Settings-UI probe through a fake.
 *
 * @param {Object|null} adapter - `{ generate, stream }` shape, or null
 *   to reset to the real module.
 * @internal
 */
export function _setProtocolAdapterForTests(adapter) {
  protocolAdapter = adapter || defaultProtocolAdapter;
}
/**
 * Build a tiny no-op message bag for the probe. 1-token "OK" reply is
 * enough to verify reachable + auth + model without burning meaningful
 * cost ($0.0001 at most cloud rates).
 */
function buildProbeMessages() {
  return {
    system: "You are a probe. Reply with exactly the word OK.",
    user: "ping",
    combined: "You are a probe. Reply with exactly the word OK.\n\n---\n\nping",
  };
}

/**
 * Wrap an AbortController + setTimeout pair so the probe call can't
 * hang past `timeoutMs`. Returned `cancel()` MUST be called in a
 * finally block to clear the timer regardless of resolution path —
 * stale timers leak memory + keep the event loop alive past process
 * shutdown.
 */
function withTimeout(timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("probe timeout")), timeoutMs);
  return { signal: ac.signal, cancel: () => clearTimeout(timer) };
}

/**
 * Issue the baseline reachability probe — a 1-token text generate.
 * Returns `{ ok, errorReason, classification }` where `classification`
 * is the `classifyProbeError` output (or `null` when ok).
 */
async function probeReachability(route, opts = {}) {
  const { signal, cancel } = withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    await protocolAdapter.generate(route, buildProbeMessages(), {
      maxTokens: 4,
      responseFormat: "text",
      signal,
    });
    return { ok: true };
  } catch (err) {
    // AGENT.md / STANDARDS.md: never use bare `console.*` for application
    // logging. Wrap through `formatLogLine` so structured-log pipelines
    // (LOG_JSON mode) pick this up with timestamps + level metadata. The
    // diagnostic context (status, elapsedMs, route attribution) is
    // serialised into the message string because `formatLogLine` produces
    // a single formatted string — matches the pattern used elsewhere in
    // `aiProvider/` (dispatcher.js:617, retry.js:64, secrets.js:77).
    const diag = {
      routeId: route?.id,
      family: route?.family,
      protocol: route?.protocol,
      baseUrl: route?.baseUrl,
      model: route?.model,
      elapsedMs: Date.now() - startedAt,
      status: err?.status ?? err?.statusCode ?? null,
      message: String(err?.message || err).slice(0, 300),
    };
    console.warn(formatLogLine("warn", null,
      `[capabilityProbe] reachability failed ${JSON.stringify(diag)}`));
    return { ok: false, classification: classifyProbeError(err) };
  } finally {
    cancel();
  }
}
/**
 * Probe JSON mode by asking for a `responseFormat: "json_object"`
 * generation. Returns `true` on success, `false` when the provider
 * rejects the request with a JSON-mode-specific error, `null` for
 * ambiguous failures (network / auth — those are surfaced by the
 * baseline reachability probe instead).
 *
 * The probe call is deliberately tiny ("emit `{}`") — even providers
 * that charge per token bill <$0.0001 for it.
 */
async function probeJsonMode(route, opts = {}) {
  const { signal, cancel } = withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    await protocolAdapter.generate(
      route,
      { system: "Reply with the JSON object {}", user: "ping", combined: "Reply with the JSON object {}\n\n---\n\nping" },
      { maxTokens: 8, responseFormat: "json_object", signal },
    );
    return true;
  } catch (err) {
    const cls = classifyProbeError(err);
    // If the provider's there + auth's good but it rejected the call,
    // the rejection is almost certainly the json-mode flag. (Auth /
    // model errors would have surfaced from the reachability probe
    // already and we wouldn't be here.) Conservatively return false
    // for any "reachable + non-rate-limit" failure.
    if (cls.reachable && cls.errorReason !== "rate_limited") return false;
    return null;
  } finally {
    cancel();
  }
}
/**
 * Vision capability is taken from the catalog rather than probed.
 *
 * Why not a real image probe? Two reasons:
 *
 *   1. **Cost.** Sending even a 1×1 PNG to a vision-capable model
 *      costs ~50–500 tokens depending on the provider's image-token
 *      formula. Doing that on every save (auto-probe-on-upsert) +
 *      every key rotation + every Settings UI "Test" click is a real
 *      expense at scale, especially across 7 agent roles per workspace.
 *
 *   2. **Signal-to-noise.** A 400 response on an image submission
 *      could mean "this model is text-only", "the image was malformed",
 *      "the SDK version doesn't support multimodal", or the provider
 *      is throttling us. Disambiguating those is brittle string-match
 *      work that lies in the same place as catalog truth anyway.
 *
 * The vision probe falls back to the static catalog
 * (`modelCatalog.capabilitiesFor(family).supportsVision`). For
 * compat-family routes this defaults to `false` — operators with
 * vision-capable compat endpoints opt in via per-slot metadata in
 * a future PR. Real-traffic vision-heal calls (`vision.js`) will
 * still surface mid-call errors if a route advertised vision and
 * the model doesn't actually support it.
 */
function probeVision(route) {
  const fam = route.family === "custom" ? "openai" : route.family;
  const caps = capabilitiesFor(fam);
  return Boolean(caps?.supportsVision);
}
/**
 * Map a thrown error from `protocolAdapter.generate` to a capability-
 * probe outcome dimension.
 *
 * Returns `{ reachable, auth, model, errorReason }` flags interpreted
 * by `runCapabilityProbe`. Mirrors the heuristics used by
 * `utils/metrics.js#classifyAiError` but specialised for the four
 * dimensions the probe cares about (network vs. auth vs. model vs.
 * other).
 *
 * Detection signals are intentionally string-pattern based — every
 * SDK we use (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`,
 * Ollama's plain `fetch`) surfaces error shapes differently, but the
 * `.status` HTTP code + `.message` text are common enough to drive
 * the classification without per-SDK branching.
 */
function classifyProbeError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  // `Number(undefined || undefined || 0) === 0`, so an error without a
  // `.status` / `.statusCode` field always yields `status === 0`. We
  // can't use `status === 0` alone as the network-error signal — many
  // SDKs throw plain `new Error("Unauthorized: invalid API key")`
  // without a status code, and treating those as network errors would
  // misroute every key-rotation failure as "endpoint unreachable".
  //
  // Fix (B2.2 follow-up): run the message-pattern checks for auth /
  // model_not_found / rate_limit BEFORE the network-error branch, and
  // tighten the bare `status === 0` fallback to fire only when the
  // message itself matches a network-shaped pattern (the regex). When
  // the status is a real HTTP code (401/403/404/429), the message
  // pattern is bypassed and the typed branch wins.
  const status = Number(err?.status || err?.statusCode || 0);
  const NETWORK_RE = /timeout|timed out|abort|econn|enotfound|eai_again|fetch failed|network|ssrf/i;

  // Auth — key invalid / revoked / wrong scope. Check FIRST so SDK
  // errors thrown with no `.status` (`new Error("Unauthorized: ...")`)
  // still classify correctly.
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|incorrect api key/i.test(msg)) {
    return { reachable: true, auth: false, errorReason: "auth_failed" };
  }
  // Model not found — model id wrong, or operator's compat endpoint
  // doesn't expose this model.
  if (status === 404 || /not found|model.*does not exist|no such model|unknown model/i.test(msg)) {
    return { reachable: true, auth: true, model: false, errorReason: "model_not_found" };
  }
  // Rate limit — provider's there + key works, just throttled. Treat
  // as reachable + auth ok; capability dimensions left unobserved.
  if (status === 429 || /rate limit|too many requests/i.test(msg)) {
    return { reachable: true, auth: true, errorReason: "rate_limited" };
  }
  // Network / DNS / SSRF / timeout — provider unreachable. Only
  // classify here when the message text matches a network pattern OR
  // the error is truly statusless AND the message is empty (a bare
  // throw with no metadata; safest to call it network). A statusless
  // error WITH a non-network message falls through to the "unknown"
  // branch below, which preserves reachability for downstream probes.
  if (NETWORK_RE.test(msg) || (status === 0 && !msg)) {
    return { reachable: false, errorReason: msg.slice(0, 200) || "network_error" };
  }
  // Unknown — assume reachable (we got *some* error response back) but
  // surface the message so the operator can see what went wrong.
  return { reachable: true, errorReason: msg.slice(0, 200) || "unknown_error" };
}
/**
 * Run every capability probe against a single route and return a
 * `capabilities` payload ready for `provider_routes.capabilities`.
 *
 * The output shape is stable across `source: "network"` (probed) and
 * `source: "catalog"` (e.g. when the network probe couldn't run) so
 * the Settings UI can render the same fields regardless of provenance.
 *
 * Sequence:
 *   1. Reachability probe (1-token text generate). On failure, return
 *      catalog floors with `reachable: false` + `errorReason` and
 *      DON'T proceed — the per-capability probes would all fail too
 *      and we'd just rate-limit ourselves against a broken provider.
 *   2. JSON-mode probe (only if reachable + auth ok).
 *   3. Vision from catalog (cost-justified — see `probeVision` JSDoc).
 *   4. Streaming + contextWindow + maxOutputTokens from catalog floor.
 *
 * @param {Object} route - The provider_routes row (must have id,
 *   workspaceId, protocol, family, model). Repo layer is responsible
 *   for getting decryptedApiKey through `secrets.getDecryptedKey`
 *   before calling `protocolAdapter.generate` — the adapter resolves
 *   the key from the route, so we don't pass it explicitly here.
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<Object>} The capabilities payload.
 */
export async function runCapabilityProbe(route, opts = {}) {
  const fam = route?.family === "custom" ? "openai" : route?.family;
  const catalogFloor = capabilitiesFor(fam) || {};
  const probedAt = new Date().toISOString();
  // Defensive: if the route is missing required dispatch fields,
  // probe can't even attempt a network call. Persist the catalog
  // floor with a synthetic errorReason so the operator knows why.
  if (!route?.id || !route?.workspaceId || !route?.protocol) {
    return {
      reachable: false,
      auth: false,
      model: false,
      vision: Boolean(catalogFloor.supportsVision),
      jsonMode: Boolean(catalogFloor.supportsJsonMode),
      tools: false,
      streaming: Boolean(catalogFloor.supportsStreaming),
      contextWindow: Number.isFinite(catalogFloor.contextWindow) ? catalogFloor.contextWindow : null,
      maxOutputTokens: Number.isFinite(catalogFloor.maxOutputTokens) ? catalogFloor.maxOutputTokens : null,
      probedAt,
      source: "catalog",
      errorReason: "route_missing_dispatch_fields",
    };
  }
  // Step 1 — reachability + auth + model (one tiny call covers all three).
  const reach = await probeReachability(route, opts);
  if (!reach.ok) {
    const cls = reach.classification;
    return {
      reachable: cls.reachable !== false,
      auth: cls.auth !== false ? cls.auth ?? null : false,
      model: cls.model !== false ? cls.model ?? null : false,
      vision: Boolean(catalogFloor.supportsVision),
      jsonMode: Boolean(catalogFloor.supportsJsonMode),
      tools: false,
      streaming: Boolean(catalogFloor.supportsStreaming),
      contextWindow: Number.isFinite(catalogFloor.contextWindow) ? catalogFloor.contextWindow : null,
      maxOutputTokens: Number.isFinite(catalogFloor.maxOutputTokens) ? catalogFloor.maxOutputTokens : null,
      probedAt,
      source: "network",
      errorReason: cls.errorReason,
    };
  }
  // Step 2 — JSON mode probe (only worth it if step 1 passed).
  let jsonMode = await probeJsonMode(route, opts);
  if (jsonMode === null) jsonMode = Boolean(catalogFloor.supportsJsonMode);
  // Step 3 — vision (catalog only, see probeVision JSDoc).
  const vision = probeVision(route);
  return {
    reachable: true,
    auth: true,
    model: true,
    vision,
    jsonMode,
    tools: false, // B4.6 (advanced routing) territory — not probed here.
    streaming: Boolean(catalogFloor.supportsStreaming),
    contextWindow: Number.isFinite(catalogFloor.contextWindow) ? catalogFloor.contextWindow : null,
    maxOutputTokens: Number.isFinite(catalogFloor.maxOutputTokens) ? catalogFloor.maxOutputTokens : null,
    probedAt,
    source: "network",
  };
}

/**
 * Test-only seam: returns the same catalog-floor capabilities payload
 * `runCapabilityProbe` would synthesise when it can't reach the
 * provider. Exported so unit tests can pin the catalog-fallback
 * shape without spinning up a fake adapter, and so B3.6's
 * key-rotation gate can construct a rejection payload deterministically.
 *
 * @internal
 */
export function _catalogOnlyCapabilities(route, errorReason = "catalog_only") {
  const fam = route?.family === "custom" ? "openai" : route?.family;
  const catalogFloor = capabilitiesFor(fam) || {};
  return {
    reachable: false,
    auth: false,
    model: false,
    vision: Boolean(catalogFloor.supportsVision),
    jsonMode: Boolean(catalogFloor.supportsJsonMode),
    tools: false,
    streaming: Boolean(catalogFloor.supportsStreaming),
    contextWindow: Number.isFinite(catalogFloor.contextWindow) ? catalogFloor.contextWindow : null,
    maxOutputTokens: Number.isFinite(catalogFloor.maxOutputTokens) ? catalogFloor.maxOutputTokens : null,
    probedAt: new Date().toISOString(),
    source: "catalog",
    errorReason,
  };
}
