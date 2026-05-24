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
import { CLOUD_KEY_MAP, CLOUD_DETECT_ORDER, getCloudModel } from "./modelCatalog.js";
import { protocolForProvider } from "./protocolForProvider.js";
// B4.6 — route-group resolution. When `agent_configs.routeId` starts
// with `"rg-"`, the id points at a `route_groups` row instead of a
// direct `provider_routes` row. `resolveGroup` picks a concrete route
// from the group using the group's strategy (weighted / latency / cost).
import { resolveGroup } from "./routeGroupResolver.js";

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
 * `stickyFallbackActive`, `resolveRoute`, and `detectProvider` only
 * delete expired entries that ALSO happen to match
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

/**
 * Classify a thrown error from a defensive `agent_configs` lookup.
 *
 * Returns `true` when the error is the expected "table doesn't exist on
 * a fresh DB" path — quiet fall-through is safe. Returns `false` for any
 * other failure (DB corruption, lock timeout, decryption error inside
 * `apiKeyRepo`, malformed schema, etc.) which we log at warn level and
 * still fall through, but with observability so ops can correlate the
 * "AI call routed to wrong provider" symptom with a real DB incident
 * instead of having it disappear silently.
 *
 * Better-sqlite3 surfaces "no such table" as `err.code === "SQLITE_ERROR"`
 * with the message containing `"no such table"`. PostgreSQL returns
 * `err.code === "42P01"` (`undefined_table`). Both shapes are matched here.
 */
function isExpectedDbMissingTable(err) {
  if (!err) return false;
  if (err.code === "42P01") return true;
  if (err.code === "SQLITE_ERROR" && /no such table/i.test(err.message || "")) return true;
  return false;
}

function logUnexpectedAgentConfigError(err, where) {
  if (isExpectedDbMissingTable(err)) return;
  // Log at warn — the call still falls through to the workspace default,
  // so it's not fatal, but the user is now silently using a different
  // provider than they configured. Surface enough context for ops to
  // correlate against DB / corruption alerts without leaking the full
  // error chain (which can carry stack traces or path info).
  const msg = err?.message?.slice(0, 200) || String(err);
  console.warn(formatLogLine(
    "warn", null,
    `[aiProvider/${where}] agent_configs lookup failed: ${err?.code || "no_code"}: ${msg}. Falling back to workspace default.`,
  ));
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

/**
 * B3.6 — Reset every circuit-breaker entry keyed off `routeId`. Called
 * by the rotate-key endpoint so a freshly-rotated key isn't shadowed
 * by a stale breaker tripped on the prior credentials. The breaker
 * keyspace stores both bare `routeId` keys (single-agent dispatch) and
 * role-scoped `routeId::role` keys (multi-agent), so we sweep both
 * shapes in one pass.
 *
 * Mirrors `resetCircuitBreaker(provider)` above, just keyed on route
 * id instead of the legacy provider enum. Exported so the routes layer
 * can call it without reaching into module internals.
 *
 * @param {string} routeId - The `provider_routes.id` whose breakers
 *   should be cleared. No-op when undefined / falsy (defensive).
 */
export function resetRouteBreakers(routeId) {
  if (!routeId) return;
  for (const key of Object.keys(circuitBreakers)) {
    if (key === routeId || key.startsWith(`${routeId}::`)) {
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

/**
 * B2.6 — `resolveRoute` is now the single dispatch-resolution path.
 *
 * Returns the concrete `provider_routes` row a dispatch call should fire
 * against. Real routes come from the DB (`provider_routes.id = "pr-..."`);
 * env-default workspaces get a transient route synthesised in-memory
 * (`id = "provider:<id>"`) so the protocol-adapter contract holds
 * uniformly.
 *
 * ### Resolution priority
 *
 *   1. **Sticky-fallback for this role** — if a recent failover pinned
 *      a route for this (role, ttl) tuple, return it. An active sticky
 *      MUST beat the configured route so a rate-limited primary stops
 *      being retried under the agent override. (AI-005 tripwire #1.)
 *   2. **`agent_configs.routeId`** — explicit per-role route assignment
 *      written by the Settings UI. Honoured when the route is usable
 *      (`provider_routes.enabled = 1` and a decryptable secret exists).
 *   3. **Env-default transient route** — when no `routeId` is set on
 *      the agent_configs row (or no row exists), `detectProvider`
 *      identifies the workspace-default provider and we synthesise a
 *      transient route from it. Collapses `effectiveAgentRole` to
 *      `null` per AI-005c so single-agent workspaces share one
 *      breaker across stages.
 *   4. **`null`** — no provider configured at all. Caller surfaces a
 *      config error to the operator.
 *
 * ### `effectiveAgentRole` collapse (AI-005c)
 *
 * Workspaces with no `agent_configs` row for the role get
 * `effectiveAgentRole: null` so downstream breakers / sticky / metrics
 * collapse to the bare-discriminator key path. Workspaces WITH a row
 * get the role string back so per-role isolation kicks in.
 *
 * @param {Object} [opts]
 * @param {string} [opts.agentRole]
 * @param {string} [opts.workspaceId]
 * @returns {{ route: Object|null, config: Object|null, effectiveAgentRole: string|null }}
 */
export function resolveRoute({ agentRole = null, workspaceId = null } = {}) {
  // Look up `agent_configs` BEFORE the sticky-fallback check so any
  // per-role overrides (`systemPromptOverride`, `maxTokens`, etc.) thread
  // through every return path — including the sticky-fallback branch.
  // Without this, a rate-limit fallback would silently drop the admin's
  // configured prompt + token cap for the entire 10-minute sticky TTL
  // (the downstream `buildEffectivePrompt(prompt, config)` in
  // `dispatcher.js` returns the raw prompt unchanged when `config` is
  // null). Mirrors the same fix applied to `resolveProvider` — cfg
  // resolution must happen up-front, not after the sticky branch.
  let cfg = null;
  if (agentRole && workspaceId) {
    try { cfg = agentConfigRepo.getByRole(workspaceId, agentRole) || null; }
    catch (err) { logUnexpectedAgentConfigError(err, "resolveRoute"); }
  }

  // (1) Sticky-fallback wins. The sticky map stores `{ provider, expiry }`
  // keyed by either a provider id or a route id — the value's `provider`
  // field is "the discriminator to dispatch against", interpreted by the
  // caller. Route-shaped stickies populate the synthetic-route shape so
  // downstream code never has to know it's looking at a fallback.
  // Unconditional sweep so expired entries for OTHER roles also get cleaned
  // up here — not just the ones that match the current role filter.
  sweepExpiredStickies();
  if (agentRole) {
    for (const [key, entry] of stickyFallbacks) {
      if (!keyHasRole(key, agentRole)) continue;
      if (Date.now() < entry.expiry) {
        // Sticky entries from `generateText`'s fallback path carry a
        // `provider` (not a route id). Synthesise a transient route
        // from it so callers see a uniform shape. Thread `cfg` so
        // per-role overrides survive the fallback window.
        if (entry.route) {
          return { route: entry.route, config: cfg, effectiveAgentRole: agentRole };
        }
        if (entry.provider && isProviderUsable(entry.provider)) {
          return {
            route: synthesiseTransientRoute({ provider: entry.provider, workspaceId }),
            config: cfg,
            effectiveAgentRole: agentRole,
          };
        }
      }
    }
  }

  // (2) Consult agent_configs for this (workspaceId, role) — we already
  // resolved `cfg` above; just branch on whether the admin configured a row.
  if (agentRole && workspaceId) {
    if (cfg) {
      // Explicit route assignment. The route row carries everything
      // dispatch needs (protocol + baseUrl + model + encrypted secret).
      // B2.1 (migration 048) dropped `cfg.provider` — the routeId
      // column is now the only dispatch signal on agent_configs rows.
      // A cfg row without routeId means the admin saved per-role
      // tuning (systemPromptOverride / maxTokens) but left routing
      // to the workspace default, so we fall through to (3) below
      // with `cfg` still in scope.
      if (cfg.routeId) {
        let route;
        // B4.6 — routeId can point at either a direct route (`pr-*`) or
        // a route group (`rg-*`). Groups are resolved to a concrete route
        // at call time using the group's strategy (weighted / latency /
        // cost). The caller never knows whether the route came from a
        // group or a direct assignment — the return shape is identical.
        if (typeof cfg.routeId === "string" && cfg.routeId.startsWith("rg-")) {
          try { route = resolveGroup(cfg.routeId, workspaceId, { agentRole }); }
          catch { /* DB unavailable or resolver error */ }
        } else {
          try { route = providerRouteRepo.getById(workspaceId, cfg.routeId); }
          catch { /* DB unavailable */ }
        }
        // Route must exist, be enabled, and belong to the same
        // workspace (getById is workspace-scoped, so the second
        // check is implicit but spelled out for clarity).
        if (route && route.enabled && route.workspaceId === workspaceId) {
          return { route, config: cfg, effectiveAgentRole: agentRole };
        }
        // Route id pointed at a disabled / deleted row (or a group with
        // zero healthy members). Don't silently fall back to env
        // detection — that would hide a misconfig. Return null so the
        // caller surfaces a config error to the user.
        return { route: null, config: cfg, effectiveAgentRole: agentRole };
      }
      // No routeId — fall through to workspace default (Migration 059)
      // then env detection. Keep `cfg` so any per-role overrides on the
      // row (systemPromptOverride, maxTokens) still apply. We return
      // `effectiveAgentRole: agentRole` (not null) because the admin DID
      // configure something for this role, even if not the route itself
      // — breakers / sticky / metrics use the per-role keyspace.
      let defaultRoute = null;
      try { defaultRoute = providerRouteRepo.getWorkspaceDefault(workspaceId); }
      catch { /* DB unavailable — fall through to env detection */ }
      if (defaultRoute && defaultRoute.enabled) {
        return { route: defaultRoute, config: cfg, effectiveAgentRole: agentRole };
      }
      const fallbackProvider = detectProvider();
      if (!fallbackProvider) return { route: null, config: cfg, effectiveAgentRole: agentRole };
      return {
        route: synthesiseTransientRoute({ provider: fallbackProvider, workspaceId }),
        config: cfg,
        effectiveAgentRole: agentRole,
      };
    }
  }

  // (3a) Migration 059 — workspace-default `provider_routes` row.
  //
  // Industry-standard pattern for autonomous multi-agent platforms
  // (Vercel AI Gateway, LangSmith, Mastra): a DB-stored "default" row
  // wins over env detection so operators see the runtime behaviour in
  // the AI Providers UI without needing to know about env vars. Env
  // detection still runs as the final safety net for dev environments
  // and freshly-provisioned workspaces with no default pinned yet.
  //
  // Visible in dispatch only when the route is enabled — a disabled
  // default falls through to env detection so disabling can't be a
  // foot-gun. Workspace-scoped, so a workspace with no default + valid
  // env keys behaves exactly the same as before this migration.
  if (workspaceId) {
    let defaultRoute = null;
    try { defaultRoute = providerRouteRepo.getWorkspaceDefault(workspaceId); }
    catch { /* DB unavailable — fall through to env detection */ }
    if (defaultRoute && defaultRoute.enabled) {
      return { route: defaultRoute, config: null, effectiveAgentRole: null };
    }
  }

  // (3b) No agent_configs row AND no workspace default → AI-005c
  // single-agent collapse. Return a route synthesised from env-detected
  // provider so dispatch can still go through the protocol adapter, but
  // collapse `effectiveAgentRole` to null so breakers / sticky / metrics
  // use the bare-discriminator path.
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
  // B2.1 — the family→protocol mapping lives in `protocolForProvider.js`
  // so the backfill script and runtime synthesis share one source of
  // truth. Throws `ERR_UNKNOWN_PROTOCOL` on unmapped providers — fail
  // closed rather than silently dispatching under the wrong wire
  // format (`protocolAdapter.moduleFor` would throw anyway, but
  // failing here gives a more actionable error message).
  const protocol = protocolForProvider(provider);
  // B4.x — resolve a concrete model id when the caller didn't supply
  // one. Without this, `route.model` stays `null` and the dispatcher's
  // `computeCostForRoute` Path 2 catalog fallback (which keys on
  // `route.model`) never fires for env-default dispatch — every
  // transient call lands `costUsd: null` even when the chosen cloud
  // model IS in `MODEL_PRICING`. The catalog model is also what
  // `protocolAdapter` actually dispatches against, so the runtime
  // contract requires SOME model id here regardless of cost.
  // `getCloudModel` returns the configured env override
  // (`ANTHROPIC_MODEL` / `OPENAI_MODEL` / etc.) or the catalog
  // default; for compat slots it falls through to null which is fine
  // — those routes always supply an explicit model via
  // `getCompatConfig().model` higher up the stack.
  let effectiveModel = model || null;
  let effectiveBaseUrl = null;
  if (isCompatProvider(provider)) {
    // Compat slots carry their own baseUrl + model on the slot config
    // (not in the env). The dispatcher's SSRF-guardedFetch is gated on
    // `route.baseUrl` (see `_callProviderUnsafe`), so dropping the
    // compat baseUrl here would silently disable the SSRF guard for
    // every transient compat dispatch — the OpenAI SDK would then fall
    // through to `api.openai.com` (its hardcoded default) with the
    // compat slot's apiKey, leaking it to a third party. Carry both
    // fields on the synthetic route so dispatch reaches the configured
    // endpoint and the SSRF guard fires.
    try {
      const slot = getCompatConfig(provider);
      if (slot) {
        effectiveBaseUrl = slot.baseUrl || null;
        if (!effectiveModel) effectiveModel = slot.model || null;
      }
    } catch { /* DB unavailable — fall through to no baseUrl */ }
  } else if (!effectiveModel) {
    try { effectiveModel = getCloudModel(provider) || null; } catch { /* unknown family */ }
  }
  return {
    id: `provider:${provider}`,
    workspaceId: workspaceId || null,
    name: `transient:${provider}`,
    family: provider,
    protocol,
    baseUrl: effectiveBaseUrl,
    model: effectiveModel,
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
    // Also the canonical "is this a transient route?" predicate used
    // by `streamText` / `callVisionModel` / `_callProviderUnsafe`.
    // The discriminator stays consistent across all dispatch paths:
    // real routes have `id` starting `"pr-"` AND no `_transient`;
    // transient routes have `id` starting `"provider:"` AND
    // `_transient: true`.
    _transient: true,
    _transientProvider: provider,
  };
}

export function detectProvider({ agentRole = null } = {}) {
  // Sticky fallback first — a successful rate-limit fallback pins the working
  // provider until the TTL expires, even if the user has the original
  // (rate-limited) provider selected in the dropdown.
  //
  // Role isolation: stickies live in two keyspaces depending on workspace
  // mode at the time `setStickyFallback` was called:
  //   • `"provider::role"` — multi-agent workspace, per-role pin.
  //   • `"provider"`       — single-agent workspace (AI-005c collapsed
  //                          `effectiveAgentRole` to null on dispatch).
  //
  // The previous `agentRole && !keyHasRole(...)` guard short-circuited
  // the role check on `null` agentRole and matched **every** sticky
  // regardless of which role pinned it (Lifeguard detect-provider
  // sticky-leak). When `detectProvider` is called WITH an `agentRole`
  // we must only match that specific role's stickies — NOT another
  // role's, and NOT a single-agent roleless sticky (which would leak
  // single-agent state into a multi-agent role's resolution). When
  // called WITHOUT an `agentRole` we may only match roleless stickies
  // (legitimate single-agent recovery state). `keyHasRole` already
  // returns false for keys without `::`, so the matching predicate is
  // simply: roleless callers want roleless keys; role-scoped callers
  // want their own role's keys.
  sweepExpiredStickies();
  for (const [key, entry] of stickyFallbacks) {
    const keyIsRoleless = !key.includes("::");
    const matches = agentRole
      ? keyHasRole(key, agentRole)
      : keyIsRoleless;
    if (!matches) continue;
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
