/**
 * @module aiProvider/registry
 * @description Owns mutable provider state — canonical state owner per AI-002.
 *
 * The orchestrator (`./index.js`) imports from here; the reverse is forbidden.
 * Future AI-005 multi-agent dispatch can extend the breaker keyspace
 * (`breakerKey(provider, role)`) inside this file without touching consumers.
 *
 * State owned here: runtime key store, Ollama runtime config, active-provider
 * override, sticky fallback, per-provider circuit breakers, compat-slot
 * config (TTL-cached), provider detection + usability + key resolution.
 */
import * as apiKeyRepo from "../database/repositories/apiKeyRepo.js";
import * as agentConfigRepo from "../database/repositories/agentConfigRepo.js";
import * as providerRouteRepo from "../database/repositories/providerRouteRepo.js";
import * as compatConfigCache from "../utils/compatConfigCache.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { CLOUD_KEY_MAP, CLOUD_DETECT_ORDER } from "./modelCatalog.js";

// ── Mutable state ────────────────────────────────────────────────────────────
const runtimeKeys = {};
let runtimeOllamaBaseUrl = "";
let runtimeOllamaModel   = "";
let runtimeOllamaDisabled = false;
let runtimeActiveProvider = null;
const stickyFallbacks = new Map();

export const STICKY_FALLBACK_TTL_MS = 10 * 60 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 1;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Does `key` belong to the given `agentRole`?
 *
 * Replaces ad-hoc `key.endsWith(`::${agentRole}`)` checks scattered through
 * this module. The old check had two failure modes:
 *
 *   1. Substring collision — a provider id ending in the role string
 *      (e.g. provider `"compat:my::planner"`) would falsely match an
 *      `agentRole="planner"` filter even though it has no role suffix.
 *   2. Empty / multi-`::` roles — admin-controlled role names could embed
 *      `::` and slip through validation, again polluting the filter.
 *
 * The split form here makes the suffix comparison exact: we split on the
 * first `::` from the right and require the right-hand side to equal
 * `agentRole`. Keys with no `::` (bare-provider stickies) never match.
 */
function keyHasRole(key, agentRole) {
  if (!agentRole) return false;
  const idx = key.lastIndexOf("::");
  if (idx < 0) return false;
  return key.slice(idx + 2) === agentRole;
}

/**
 * Sweep every expired entry from `stickyFallbacks` regardless of role.
 *
 * Without this, the per-role iterations in `clearStickyFallback`,
 * `stickyFallbackActive`, `resolveProvider`, `resolveRoute`, and
 * `detectProvider` only delete expired entries that ALSO happen to match
 * the role filter. Expired entries for other roles sit in the Map until
 * something else triggers a sweep — a slow memory leak proportional to
 * `STICKY_FALLBACK_TTL_MS × write rate × role count`.
 *
 * Cheap: O(n) over a tiny Map (sticky entries are bounded by active role
 * count, ~8 in practice).
 */
function sweepExpiredStickies() {
  const now = Date.now();
  for (const [k, v] of stickyFallbacks) {
    if (now >= v.expiry) stickyFallbacks.delete(k);
  }
}

/** @type {Object<string, {failures: number, disabledUntil: number}>} */
const circuitBreakers = {};
/**
 * Compose a circuit-breaker / sticky-fallback / metric key from a primary
 * discriminator and an optional agent role.
 *
 * The primary discriminator was originally a `provider` id (AI-005) and is
 * now ALSO a `routeId` (B1.6) — same shape, different opaque string. Two
 * named wrappers are exported so call sites are explicit about which axis
 * they're keying on, but they share one implementation because the
 * breaker map doesn't care which kind of id keys it:
 *
 *   • {@link breakerKey} — legacy alias kept for AI-005 callers that still
 *     key breakers by provider.
 *   • {@link routeBreakerKey} — B1.6 callers keying by `provider_routes.id`.
 *
 * Both produce `${id}` or `${id}::${agentRole}`. Mixing kinds in a single
 * deployment is safe (provider ids and route ids are disjoint namespaces
 * — providers are short enum strings like `"anthropic"`, route ids are
 * UUIDv4 prefixed `"pr-..."`).
 */
export function breakerKey(idOrProvider, agentRole) {
  return agentRole ? `${idOrProvider}::${agentRole}` : idOrProvider;
}

/**
 * B1.6 — same shape as {@link breakerKey} but documents the route-id
 * call site. Use when the breaker is being keyed off a `provider_routes`
 * row rather than the legacy provider enum.
 *
 * @param {string} routeId
 * @param {string|null} [agentRole]
 * @returns {string}
 */
export function routeBreakerKey(routeId, agentRole) {
  return breakerKey(routeId, agentRole);
}

/**
 * B1.6 — Extract the stable breaker-key discriminator from a resolved
 * route. **This is the only function B2 dispatch should use** when
 * keying breakers / sticky-fallback / metrics off a route, because it
 * preserves the AI-005 breaker namespace across the transient-route
 * shim.
 *
 * Without this helper, single-agent workspaces would silently shift
 * from the `anthropic` breaker key (AI-005 today) to `provider:anthropic`
 * (B1.6 synthetic-route id) on first call after B2 ships, resetting
 * every workspace's breaker state mid-flight. Operators watching a
 * 429-incident dashboard would see the breaker counts collapse to zero
 * without an obvious cause. By stripping the `provider:` prefix here,
 * transient routes collapse back to the legacy bare-provider key and
 * dispatch accounting stays continuous across the bundle.
 *
 * Real routes (id = `pr-<uuid>`) pass through unchanged — they get
 * their own breaker key, isolated from every other route.
 *
 * @param {Object} route - A route object from {@link resolveRoute}.
 * @returns {string} The breaker-key discriminator.
 */
export function breakerDiscriminator(route) {
  if (!route?.id) return "unknown";
  // Transient routes synthesised by `synthesiseTransientRoute` carry
  // both the `_transient` marker and an id prefixed `provider:`. Either
  // check is sufficient; we use the marker (cheaper, type-stable) with
  // the prefix as a defensive fallback in case a future code path
  // builds a transient route without setting the marker.
  if (route._transient || (typeof route.id === "string" && route.id.startsWith("provider:"))) {
    return route._transientProvider || route.id.slice("provider:".length);
  }
  return route.id;
}

// ── Compat helpers ───────────────────────────────────────────────────────────
export function isCompatProvider(provider) {
  return typeof provider === "string"
    && provider.startsWith("compat:")
    && provider.length > "compat:".length;
}

export function getCompatConfig(provider) {
  if (!isCompatProvider(provider)) return null;
  // TTL cache avoids hitting SQLite (decrypt + JSON.parse) on every AI call.
  return compatConfigCache.get(provider, () => apiKeyRepo.getCompatSlot(provider));
}

// ── Key resolution ───────────────────────────────────────────────────────────
export function getKey(envName) {
  // `in` semantics so runtimeKeys[envName] = "" (explicit deactivation) takes
  // precedence over the env var. `||` would treat "" as falsy.
  if (envName in runtimeKeys) return runtimeKeys[envName];
  const envVal = process.env[envName] || "";
  if (envVal) return envVal;
  // DEMO-MODE: platform-owned demo key for Google when no user key is set.
  if (envName === "GOOGLE_API_KEY" && process.env.DEMO_GOOGLE_API_KEY) {
    return process.env.DEMO_GOOGLE_API_KEY;
  }
  return "";
}

/** Get a user-configured key WITHOUT the demo fallback (for BYOK detection). */
export function getUserConfiguredKey(envName) {
  if (envName in runtimeKeys) return runtimeKeys[envName];
  return process.env[envName] || "";
}

export function getOllamaBaseUrl() {
  return runtimeOllamaBaseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
}

export function getOllamaModel() {
  return runtimeOllamaModel || process.env.OLLAMA_MODEL || "mistral:7b";
}

export function hasOllamaConfig() {
  return !!(runtimeOllamaBaseUrl || runtimeOllamaModel
    || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL);
}

export function isOllamaDisabled() { return runtimeOllamaDisabled; }

// loadKeysFromDatabase seeds caches from DB at startup without clobbering env.
export function setCloudKeyFromDb(envName, value) {
  if (!process.env[envName] && !(envName in runtimeKeys)) {
    runtimeKeys[envName] = String(value);
    return true;
  }
  return false;
}

export function setOllamaCacheFromDb(cfg) {
  if (!runtimeOllamaBaseUrl && !process.env.OLLAMA_BASE_URL) {
    runtimeOllamaBaseUrl = cfg.baseUrl || "";
  }
  if (!runtimeOllamaModel && !process.env.OLLAMA_MODEL) {
    runtimeOllamaModel = cfg.model || "";
  }
  runtimeOllamaDisabled = false;
}

// ── Mutators ─────────────────────────────────────────────────────────────────
export function setRuntimeKey(provider, key) {
  if (isCompatProvider(provider)) {
    // Compat providers persist via apiKeyRepo.setCompatSlot() in settings.js.
    resetCircuitBreaker(provider);
    clearStickyFallback();
    return;
  }
  const envName = CLOUD_KEY_MAP[provider];
  if (!envName) return;
  runtimeKeys[envName] = key;
  // FEA-003: reset breaker so new credentials are retried immediately.
  resetCircuitBreaker(provider);
  clearStickyFallback();
  try {
    if (key) apiKeyRepo.set(provider, key);
    else apiKeyRepo.remove(provider);
  } catch (err) {
    // DB unavailable during tests or before init — safe to ignore.
    console.error(formatLogLine("error", null, `[aiProvider] Failed to persist key for ${provider}: ${err.message}`));
  }
}

export function setRuntimeOllama({ baseUrl, model, disabled } = {}) {
  if (baseUrl  !== undefined) runtimeOllamaBaseUrl  = baseUrl;
  if (model    !== undefined) runtimeOllamaModel    = model;
  if (disabled !== undefined) runtimeOllamaDisabled = disabled;
  try {
    if (disabled) {
      apiKeyRepo.remove("local");
    } else if (runtimeOllamaBaseUrl || runtimeOllamaModel) {
      apiKeyRepo.set("local", { baseUrl: runtimeOllamaBaseUrl, model: runtimeOllamaModel });
    }
  } catch (err) {
    console.error(formatLogLine("error", null, `[aiProvider] Failed to persist Ollama config: ${err.message}`));
  }
}

export function setActiveProvider(provider) {
  runtimeActiveProvider = provider || null;
  // User chose a provider — clear sticky fallback so detection re-evaluates.
  clearStickyFallback();
}

// ── Sticky fallback ──────────────────────────────────────────────────────────
export function setStickyFallback(provider, agentRole = null) {
  stickyFallbacks.set(breakerKey(provider, agentRole), {
    provider,
    expiry: Date.now() + STICKY_FALLBACK_TTL_MS,
  });
}

export function clearStickyFallback(agentRole = null) {
  if (!agentRole) return stickyFallbacks.clear();
  for (const [k] of stickyFallbacks) if (keyHasRole(k, agentRole)) stickyFallbacks.delete(k);
}

export function stickyFallbackActive(agentRole = null) {
  sweepExpiredStickies();
  for (const [k, v] of stickyFallbacks) {
    if ((agentRole ? keyHasRole(k, agentRole) : true) && Date.now() < v.expiry) return true;
  }
  return false;
}

// ── Circuit breaker (FEA-003) ────────────────────────────────────────────────
export function recordProviderFailure(provider, agentRole = null) {
  const key = breakerKey(provider, agentRole);
  if (!circuitBreakers[key]) circuitBreakers[key] = { failures: 0, disabledUntil: 0 };
  circuitBreakers[key].failures += 1;
  if (circuitBreakers[key].failures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreakers[key].disabledUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    console.warn(formatLogLine("warn", null, `[aiProvider] Circuit breaker tripped for ${provider} — disabled for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s after ${CIRCUIT_BREAKER_THRESHOLD} consecutive rate-limit failures`));
  }
}

export function recordProviderSuccess(provider, agentRole = null) {
  const key = breakerKey(provider, agentRole);
  if (circuitBreakers[key]) circuitBreakers[key].failures = 0;
}

export function isCircuitBreakerOpen(provider, agentRole = null) {
  const cb = circuitBreakers[breakerKey(provider, agentRole)];
  if (!cb) return false;
  if (cb.disabledUntil > Date.now()) return true;
  if (cb.disabledUntil > 0) { cb.disabledUntil = 0; cb.failures = 0; }
  return false;
}

function resetCircuitBreaker(provider) {
  // AI-005: breaker keys are now `provider` OR `provider::agentRole`. A
  // credential reset must clear every role-scoped variant — otherwise a
  // user fixing an API key on a rate-limited Claude planner would still see
  // the per-role breaker stay tripped for 5 minutes.
  for (const key of Object.keys(circuitBreakers)) {
    if (key === provider || key.startsWith(`${provider}::`)) {
      circuitBreakers[key].failures = 0;
      circuitBreakers[key].disabledUntil = 0;
    }
  }
}

// ── Provider detection ───────────────────────────────────────────────────────
export function isProviderUsable(provider) {
  if (provider === "local") return !runtimeOllamaDisabled;
  if (isCompatProvider(provider)) {
    // Wrap so a transient DB failure during cache miss doesn't crash hot paths.
    try {
      const compat = getCompatConfig(provider);
      return !!(compat?.apiKey && compat?.baseUrl && compat?.model);
    } catch { return false; }
  }
  const envName = CLOUD_KEY_MAP[provider];
  if (!envName) return false;
  if (envName in runtimeKeys) return runtimeKeys[envName].length > 0;
  if (process.env[envName]) return true;
  if (envName === "GOOGLE_API_KEY" && process.env.DEMO_GOOGLE_API_KEY) return true;
  return false;
}

export function resolveProvider({ agentRole = null, workspaceId = null } = {}) {
  // AI-005 detection priority: sticky-fallback > agentRole > quick-switch > env > auto-detect.
  // An active sticky-fallback for this role MUST win over the configured agent
  // provider — otherwise a rate-limited primary keeps being retried under the
  // agent override and silently collapses the multi-agent dispatch. This is
  // tripwire #1 from the AI-005 spec.
  //
  // Look up the agent_configs row ONCE up front so it can be threaded
  // through every return path that follows. Without this, the sticky-
  // fallback branch below would return `config: null` and silently drop
  // `systemPromptOverride` + per-role `maxTokens` during the 10-min
  // sticky window — the admin-configured prompt for this role would
  // never be applied while the fallback provider is active.
  let cfg = null;
  if (agentRole && workspaceId) {
    // Defensive try/catch — the `agent_configs` table may not exist yet on
    // fresh DBs where migrations haven't run, and we never want a transient
    // SQLite error to crash every AI call. Falling through to env detection
    // mirrors the single-agent path and matches the defensive pattern used
    // elsewhere in this file (see `isProviderUsable` for compat slots, and
    // `listCompatSlots` in `detectProvider`).
    try { cfg = agentConfigRepo.getByRole(workspaceId, agentRole) || null; }
    catch { /* DB unavailable — fall through to detection */ }
  }
  // Unconditional sweep so expired entries for OTHER roles also get cleaned
  // up here — not just the ones that match the current role filter.
  sweepExpiredStickies();
  if (agentRole) {
    for (const [key, entry] of stickyFallbacks) {
      if (!keyHasRole(key, agentRole)) continue;
      if (Date.now() < entry.expiry && isProviderUsable(entry.provider)) {
        // Preserve the agent_configs row here so `systemPromptOverride`
        // and `maxTokens` keep applying during the sticky-fallback window.
        // The provider id comes from the sticky entry (the working fallback),
        // but the role-specific config still drives prompt + token budget.
        return { provider: entry.provider, config: cfg, effectiveAgentRole: agentRole };
      }
    }
  }
  if (cfg?.provider && isProviderUsable(cfg.provider)) {
    return { provider: cfg.provider, config: cfg, effectiveAgentRole: agentRole };
  }
  // AI-005c (single-agent preservation): when no per-role agent_config row
  // exists for this workspace+role, the call falls back to the workspace
  // default provider. In that case it is **not** a multi-agent call — it's
  // a single-agent call that happens to carry an `agentRole` label for
  // future routing. Return `effectiveAgentRole: null` so downstream
  // breakers, sticky-fallback, and metrics all collapse to the bare-provider
  // key path, preserving pre-AI-005 wasted-call counts during 429 incidents.
  // Multi-agent mode lights up automatically the moment a workspace adds an
  // `agent_configs` row for the role.
  //
  // We deliberately pass NO `agentRole` to `detectProvider` here — role-scoped
  // sticky entries were already consulted above, and any sticky persisted via
  // `setStickyFallback(provider, effectiveAgentRole)` during single-agent
  // fallback collapses to the BARE-key path (effectiveAgentRole=null →
  // breakerKey="openai"). Forwarding `agentRole` would filter those bare-key
  // stickies out, regressing the AI-005c "ONE breaker shared across stages"
  // contract and reintroducing the wasted-call amplification during 429s.
  const provider = detectProvider();
  if (!provider) return { provider: null, config: null, effectiveAgentRole: null };
  // If a role-specific agent_configs row exists but its `provider` column
  // was null/empty (admin saved "use workspace default" while still setting
  // systemPromptOverride / maxTokens), preserve the config so those role
  // overrides still apply. effectiveAgentRole stays the original role —
  // the admin DID configure something for this role, even if not provider —
  // so breakers / sticky / metrics use the per-role keyspace.
  if (cfg) return { provider, config: cfg, effectiveAgentRole: agentRole };
  return { provider, config: null, effectiveAgentRole: null };
}

/**
 * B1.6 — Route-driven counterpart to {@link resolveProvider}.
 *
 * Returns the concrete `provider_routes` row a dispatch call should fire
 * against. Additive: callers that opt in get rows from the B1.x route
 * table; callers that don't keep using `resolveProvider` and the legacy
 * env-driven `buildAdapterOpts` path. The two helpers will coexist
 * through B2; a later bundle retires `resolveProvider` once every call
 * site is route-aware.
 *
 * ### Resolution priority
 *
 *   1. **Sticky-fallback for this role** — if a recent failover pinned
 *      a route for this (role, ttl) tuple, return it. Mirrors the
 *      AI-005 tripwire #1 invariant from `resolveProvider`: an active
 *      sticky-fallback MUST beat the configured route so a rate-
 *      limited primary stops being retried under the agent override.
 *   2. **`agent_configs.routeId`** — explicit per-role route assignment
 *      written by the Settings UI. Honoured when the route is usable
 *      (`provider_routes.enabled = 1` and a decryptable secret exists).
 *   3. **Provider-column shim** — when no `routeId` is set, the legacy
 *      `agent_configs.provider` column still drives selection. We
 *      synthesise a **transient** route — an in-memory object that
 *      satisfies the B1.5 protocol-adapter contract without ever
 *      hitting `provider_routes`. Lets workspaces adopt AI-005 dispatch
 *      semantics without migrating to routes first.
 *   4. **`null`** — when neither column is set, return a null route
 *      and let the caller fall through to {@link resolveProvider} for
 *      env-default detection. Preserves AI-005c single-agent
 *      collapse (`effectiveAgentRole: null`).
 *
 * ### `effectiveAgentRole` collapse
 *
 * Same rule as `resolveProvider`: workspaces with no `agent_configs`
 * row for the role get `effectiveAgentRole: null` so downstream
 * breakers / sticky / metrics collapse to the bare-discriminator key
 * path. Workspaces WITH a row (route-driven or shim) get the role
 * string back so per-role isolation kicks in.
 *
 * @param {Object} [opts]
 * @param {string} [opts.agentRole]
 * @param {string} [opts.workspaceId]
 * @returns {{ route: Object|null, config: Object|null, effectiveAgentRole: string|null }}
 */
export function resolveRoute({ agentRole = null, workspaceId = null } = {}) {
  // (1) Sticky-fallback wins — same shape as resolveProvider's check.
  // The sticky map stores `{ provider, expiry }` keyed by either a
  // provider id or a route id (B1.6 reuses the existing map; the
  // value's `provider` field becomes "the discriminator to dispatch
  // against", interpreted by the caller). Route-shaped stickies
  // populate the synthetic-route shape so downstream code never has
  // to know it's looking at a fallback.
  // Unconditional sweep so expired entries for OTHER roles also get cleaned
  // up here — not just the ones that match the current role filter.
  sweepExpiredStickies();
  if (agentRole) {
    for (const [key, entry] of stickyFallbacks) {
      if (!keyHasRole(key, agentRole)) continue;
      if (Date.now() < entry.expiry) {
        // Sticky entries written by `resolveProvider`'s fallback path
        // carry a `provider` (not a route id). Synthesise a transient
        // route from it so callers see a uniform shape.
        if (entry.route) {
          return { route: entry.route, config: null, effectiveAgentRole: agentRole };
        }
        if (entry.provider && isProviderUsable(entry.provider)) {
          return {
            route: synthesiseTransientRoute({ provider: entry.provider, workspaceId }),
            config: null,
            effectiveAgentRole: agentRole,
          };
        }
      }
    }
  }

  // (2) + (3): consult agent_configs for this (workspaceId, role).
  if (agentRole && workspaceId) {
    let cfg;
    try { cfg = agentConfigRepo.getByRole(workspaceId, agentRole); }
    catch { /* DB unavailable — fall through to env detection */ }
    if (cfg) {
      // (2) Explicit route assignment. The route row carries everything
      // dispatch needs (protocol + baseUrl + model + encrypted secret).
      if (cfg.routeId) {
        let route;
        try { route = providerRouteRepo.getById(workspaceId, cfg.routeId); }
        catch { /* DB unavailable */ }
        // Route must exist, be enabled, and belong to the same
        // workspace (getById is workspace-scoped, so the second
        // check is implicit but spelled out for clarity).
        if (route && route.enabled && route.workspaceId === workspaceId) {
          return { route, config: cfg, effectiveAgentRole: agentRole };
        }
        // Route id pointed at a disabled / deleted row. Don't silently
        // fall back to the provider shim — that would hide a misconfig.
        // Return null so the caller surfaces a config error to the user.
        return { route: null, config: cfg, effectiveAgentRole: agentRole };
      }
      // (3) No routeId — synthesise a transient route from the legacy
      // provider column. This is the AI-005 shim that lets workspaces
      // dispatch via routes WITHOUT having migrated their config yet.
      if (cfg.provider && isProviderUsable(cfg.provider)) {
        return {
          route: synthesiseTransientRoute({ provider: cfg.provider, model: cfg.model, workspaceId }),
          config: cfg,
          effectiveAgentRole: agentRole,
        };
      }
    }
  }

  // (4) No agent_configs row → AI-005c single-agent collapse. Return
  // a route synthesised from the workspace-default provider so
  // dispatch can still go through the B1.5 protocol adapter, but
  // collapse `effectiveAgentRole` to null so breakers / sticky /
  // metrics use the bare-discriminator path.
  const provider = detectProvider();
  if (!provider) return { route: null, config: null, effectiveAgentRole: null };
  return {
    route: synthesiseTransientRoute({ provider, workspaceId }),
    config: null,
    effectiveAgentRole: null,
  };
}

/**
 * B1.6 — Build an in-memory route object from a legacy `provider` id
 * (and optional model override) so callers can dispatch via the B1.5
 * protocol-adapter contract without a real `provider_routes` row.
 *
 * The transient route has:
 *   • `id` = the synthetic `provider:<id>` discriminator. **Dispatch
 *     callers MUST use {@link breakerDiscriminator}(route) — NOT
 *     `route.id` directly — when keying breakers / sticky-fallback /
 *     metrics.** That helper strips the `provider:` prefix so single-
 *     agent workspaces collapse back to the legacy bare-provider
 *     breaker namespace (`anthropic`, not `provider:anthropic`).
 *     Without it, every workspace's breaker state resets to zero on
 *     first call after B2 ships — see the helper's JSDoc for why.
 *   • `protocol` = the wire protocol the legacy provider speaks
 *     (anthropic / openai / gemini / ollama). Compat slots and
 *     OpenRouter both speak the OpenAI protocol.
 *   • `apiKey` is NOT carried — protocol modules expect the caller
 *     (B1.5 `protocolAdapter`) to resolve the decrypted key via
 *     `secrets.getDecryptedKey`. For the transient path, the caller
 *     falls back to the legacy `getKey(envName)` route in dispatch.
 *
 * Synthetic ids stay in their own namespace (`provider:*`) so they
 * never collide with real route ids (`pr-...`).
 *
 * @param {Object} args
 * @param {string} args.provider
 * @param {string} [args.model]
 * @param {string} [args.workspaceId]
 * @returns {Object} A transient route object.
 * @internal — exported for tests via the module surface; not part of the public API.
 */
function synthesiseTransientRoute({ provider, model, workspaceId }) {
  const protocolMap = {
    anthropic: "anthropic",
    openai:    "openai",
    openrouter: "openai",
    google:    "gemini",
    local:     "ollama",
  };
  const protocol = isCompatProvider(provider)
    ? "openai"
    : protocolMap[provider] || "openai";
  return {
    id: `provider:${provider}`,
    workspaceId: workspaceId || null,
    name: `transient:${provider}`,
    family: provider,
    protocol,
    baseUrl: null,
    model: model || null,
    apiKeyLastFour: null,
    capabilities: null,
    pricing: null,
    rpmLimit: null,
    tpmLimit: null,
    cacheEnabled: 0,
    cacheTtlSec: 0,
    fallbackRouteId: null,
    enabled: 1,
    // Marker — lets the protocol-adapter caller detect a synthetic
    // route and resolve the apiKey via the legacy `getKey(envName)`
    // path instead of `secrets.getDecryptedKey(workspaceId, routeId)`.
    _transient: true,
    _transientProvider: provider,
  };
}

export function detectProvider({ agentRole = null } = {}) {
  // Sticky fallback first — a successful rate-limit fallback pins the working
  // provider until the TTL expires, even if the user has the original
  // (rate-limited) provider selected in the dropdown.
  sweepExpiredStickies();
  for (const [key, entry] of stickyFallbacks) {
    if (agentRole && !keyHasRole(key, agentRole)) continue;
    if (Date.now() < entry.expiry && isProviderUsable(entry.provider)) return entry.provider;
  }

  if (runtimeActiveProvider) {
    if (isProviderUsable(runtimeActiveProvider)) return runtimeActiveProvider;
    runtimeActiveProvider = null;
  }

  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced) {
    if (forced === "local") return "local";
    if (!CLOUD_KEY_MAP[forced]) throw new Error(`Unknown AI_PROVIDER="${forced}". Valid: anthropic, openai, google, openrouter, local`);
    if (!getKey(CLOUD_KEY_MAP[forced])) throw new Error(`AI_PROVIDER="${forced}" but ${CLOUD_KEY_MAP[forced]} is not set`);
    return forced;
  }

  const detected = CLOUD_DETECT_ORDER.find((id) => isProviderUsable(id));
  if (detected) return detected;

  try {
    const compatSlot = apiKeyRepo.listCompatSlots().find((id) => isProviderUsable(id));
    if (compatSlot) return compatSlot;
  } catch { /* DB unavailable — fall through to Ollama */ }

  if (isProviderUsable("local") && hasOllamaConfig()) return "local";
  return null;
}

export function getFallbackProviders(primaryProvider, agentRole = null) {
  if (primaryProvider === "local") return [];
  // Cloud tier falls back to other cloud providers + compat slots — same wire
  // format, same circuit-breaker accounting per slot. Local is excluded
  // (cross-tier prompt-shape mismatch — see CLOUD_DETECT_ORDER doc).
  let compatSlots = [];
  try { compatSlots = apiKeyRepo.listCompatSlots(); } catch { /* DB unavailable */ }
  const candidates = [...CLOUD_DETECT_ORDER, ...compatSlots];
  return candidates.filter((p) =>
    p !== primaryProvider
    && isProviderUsable(p)
    && !isCircuitBreakerOpen(p, agentRole),
  );
}

// ── Database key persistence ─────────────────────────────────────────────────
/**
 * Restore all persisted API keys and Ollama config from the DB into the
 * runtime cache. Called once at server startup after the DB is initialised.
 * Keys stored in the DB take precedence over default detection only when no
 * matching env var is already set — env vars remain the canonical override.
 *
 * @returns {number} Number of providers successfully loaded from the database.
 */
export function loadKeysFromDatabase() {
  let loaded = 0;
  try {
    const entries = apiKeyRepo.getAll();
    for (const { provider, value } of entries) {
      if (provider === "local") {
        if (value && typeof value === "object") {
          setOllamaCacheFromDb(value);
          loaded += 1;
        }
      } else if (isCompatProvider(provider)) {
        // Compat slots are read on demand via getCompatConfig() — no cache
        // restore needed, just count for the boot log.
        if (value && typeof value === "object" && value.apiKey && value.baseUrl && value.model) {
          loaded += 1;
        }
      } else {
        const envName = CLOUD_KEY_MAP[provider];
        if (!envName) continue;
        if (setCloudKeyFromDb(envName, value)) loaded += 1;
      }
    }
    if (loaded > 0) {
      console.log(formatLogLine("info", null, `[aiProvider] Restored ${loaded} provider key(s) from database`));
    }
  } catch (err) {
    // Non-fatal: server still works with env vars; log and continue.
    console.error(formatLogLine("error", null, `[aiProvider] Failed to load keys from database: ${err.message}`));
  }
  return loaded;
}
