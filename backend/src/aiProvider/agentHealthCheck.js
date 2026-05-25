/**
 * @module aiProvider/agentHealthCheck
 * @description AI-005 tripwire #4 — pre-run agent health check.
 *
 * Before kicking off a long-running pipeline (crawl + generate + run), validate
 * that every configured agent's provider is reachable and the API key works.
 * Without this, a misconfigured critic key fails at minute 9 after the planner
 * + codegen have already burned spend.
 *
 * Per-role health is established by issuing a 1-token throwaway `generateText`
 * call against each `(workspaceId, role)` pair the workspace has configured.
 * Roles with no `agent_configs` row are skipped — the multi-agent dispatch
 * already falls back to the workspace default for unconfigured roles, so they
 * inherit the default provider's health.
 *
 * Returns `{ ok, agentRoles: { <role>: { ok, reason } } }`. Callers should
 * surface `ERR_AGENT_HEALTH_CHECK_FAILED` (an `Error` with `code` and
 * `agentRoles` attached) when `ok === false` so CI / SSE consumers can render
 * the per-role breakdown.
 */

import * as agentConfigRepo from "../database/repositories/agentConfigRepo.js";
import { generateText } from "./index.js";
// B2.3 — `resolveRoute` replaces the legacy `resolveProvider` for both
// the per-role provider lookup AND the dedup-bucket key. After
// migration 048 dropped `agent_configs.provider`, `resolveProvider`
// silently falls through to env detection, which collapses every
// role into the same bucket and defeats the per-(workspace, route)
// probe granularity multi-tenant deployments expect.
import { resolveRoute } from "./registry.js";

/**
 * Canonical AI-005 **user-configurable** agent role names — the closed set
 * that an admin may save in `agent_configs` via the Settings → Agent Roles
 * UI / `POST /api/v1/settings/agent-roles`. This is the single source of
 * truth: `backend/src/routes/settings.js` imports this list for route-level
 * validation, and `frontend/src/config.js` mirrors it byte-for-byte for the
 * Settings UI dropdown. Adding a new role here lights it up in three places
 * (validator, UI dropdown, health-check probe) — but it must ALSO be wired
 * into a real pipeline call site (`agentRole: "<name>"` in a `generateText`
 * call) before it produces any observable behaviour.
 *
 * The synthetic `"default"` label used by `recordAiTokens` for unscoped
 * calls is INTENTIONALLY excluded — it's a Prometheus catch-all, not a
 * configurable role. The combined cardinality enumeration (this list +
 * `"default"`) lives in {@link METRIC_AGENT_ROLES} below.
 *
 * @type {string[]}
 */
export const AGENT_ROLES = Object.freeze([
  "explorer",
  "planner",
  "author",
  "oracle",
  "reviewer",
  "healer",
  "triager",
]);

/**
 * AI-005 **metric label** cardinality enumeration — the full set of values
 * `agent_role` can take on the four AI Prometheus metrics. This is
 * `AGENT_ROLES + "default"` (the synthetic catch-all `recordAiTokens` emits
 * when a call site doesn't pass an `agentRole`, e.g. legacy code paths or
 * the workspace-default fallback in single-agent mode).
 *
 * Used by dashboards and alert rules that enumerate the full label space.
 * Bounded cardinality contract: 8 metric-role values × 5 provider labels ×
 * 3 outcomes ≈ 120 series per metric — well under Prometheus's 10k/metric
 * recommended ceiling. Adding a new role to `AGENT_ROLES` automatically
 * grows this list by one.
 *
 * @type {string[]}
 */
export const METRIC_AGENT_ROLES = Object.freeze([...AGENT_ROLES, "default"]);

/**
 * Issue a 1-token probe call against one (workspaceId, role) pair.
 *
 * @param {string} workspaceId
 * @param {string} role
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, reason: string|null, provider: string|null}>}
 */
async function probeRole(workspaceId, role, signal) {
  // The try/catch wraps BOTH `resolveRoute` and `generateText` because
  // `resolveRoute` itself can throw (e.g. forced `AI_PROVIDER` pointing
  // at an unknown id surfaces as a synchronous throw from `detectProvider`,
  // and `synthesiseTransientRoute` throws `ERR_UNKNOWN_PROTOCOL` on an
  // unmapped provider). Without this wrapper, the throw would propagate
  // through `Promise.all` in `validateAgentConfigs` and abandon the probe
  // results for every other role — converting a one-role config error
  // into a total health-check failure for the workspace.
  let provider = null;
  try {
    // Resolve first so we can report which provider would have been used
    // even when the probe call fails. `resolveRoute` returns `route:
    // null` when nothing is usable — surface that as a config error,
    // not a network failure. Provider id comes from `route.family`
    // (real route) or `route._transientProvider` (shim) — same pattern
    // as `dispatcher.resolveAgentCall`.
    const { route } = resolveRoute({ agentRole: role, workspaceId });
    provider = route?._transientProvider || route?.family || null;
    if (!provider) {
      return { ok: false, reason: "no_provider_configured", provider: null };
    }
    // `responseFormat: "text"` is critical here. `generateText` →
    // `buildAdapterOpts` defaults `responseFormat` to `"json_object"`
    // (see `dispatcher.js#buildAdapterOpts`). Sending a bare "ping" prompt
    // under JSON mode causes OpenAI (and other strict-JSON providers) to
    // reject the request with a 400 "must contain the word 'json'" error,
    // which the probe would then misreport as a credential / connectivity
    // failure — falsely aborting every crawl + generate run for any
    // workspace whose agent_configs row points at OpenAI. The health
    // check probes reachability, not schema compliance, so plain text is
    // the right protocol here.
    await generateText("ping", {
      agentRole: role,
      workspaceId,
      maxTokens: 1,
      signal,
      responseFormat: "text",
    });
    return { ok: true, reason: null, provider };
  } catch (err) {
    return {
      ok: false,
      reason: sanitiseProbeReason(err),
      provider,
    };
  }
}

/**
 * Strip secret-shaped tokens out of an error string before it lands in the
 * probe's `reason` field. The reason flows through `assertAgentConfigsHealthy`
 * into `ERR_AGENT_HEALTH_CHECK_FAILED.message`, which is logged in run logs
 * (`backend/src/crawler.js#logWarn` calls in the health-check failure path)
 * and surfaced to the operator via SSE / API responses. A misbehaving SDK
 * that echoes the full Authorization header into its error message would
 * leak the API key prefix without this filter.
 *
 * Strategy: prefer `err.code` (always a small enum like `ERR_AUTH`) when set;
 * fall back to a redacted slice of `err.message`.
 */
function sanitiseProbeReason(err) {
  if (err?.code) return String(err.code);
  const raw = err?.message || "";
  if (!raw) return "probe_failed";
  // Redact common API-key prefixes + Authorization-header shapes. These are
  // the patterns most SDKs leak when echoing 401/403 responses verbatim.
  // The replacement is the literal "[redacted]" so the operator can see
  // "we removed something here" rather than silently truncated context.
  // The last replacement uses a function replacer because the previous
  // string-literal form `"$&-[redacted]".replace(/[^:=]+$/, "[redacted]")`
  // was a parse-time bug: the inner `.replace()` ran ONCE against the
  // literal `"$&-[redacted]"` (no `:`/`=` chars), collapsing the whole
  // replacement string to `"[redacted]"` and erasing the header name from
  // the operator's error reason. The function form runs per-match against
  // the real captured text, preserves the header label (`authorization:` /
  // `x-api-key=`), and redacts only the value so operators retain enough
  // context to diagnose which header type leaked.
  const redacted = raw
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/\bBearer\s+[A-Za-z0-9_.\-+/=]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(authorization|x-api-key)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]");
  return redacted.slice(0, 200);
}

/**
 * Validate every agent_config row in a workspace by issuing a 1-token probe.
 *
 * @param {string} workspaceId
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {string[]} [opts.roles] - Optional explicit role list to probe.
 *   When omitted, defaults to every role with a row in `agent_configs`.
 * @returns {Promise<{ok: boolean, agentRoles: Record<string, {ok: boolean, reason: string|null, provider: string|null}>}>}
 */
export async function validateAgentConfigs(workspaceId, { signal, roles } = {}) {
  if (!workspaceId) return { ok: true, agentRoles: {} };
  let probeRoles = roles;
  if (!probeRoles) {
    try {
      probeRoles = agentConfigRepo.listByWorkspace(workspaceId).map((r) => r.role);
    } catch {
      // DB unavailable during boot / tests — treat as "no configured agents"
      // so the pipeline runs against the workspace default.
      return { ok: true, agentRoles: {} };
    }
  }
  // Defence-in-depth: clamp to the canonical `AGENT_ROLES` allowlist + dedupe.
  // The settings route validates this on save (`backend/src/routes/settings.js`)
  // but the repo itself has no `role IN (...)` constraint — a future migration
  // or hand-written script could backfill rows with off-list roles. Clamping
  // here keeps the parallel-probe fanout bounded at `AGENT_ROLES.length` and
  // prevents an unbounded `Promise.all` from spawning a probe per junk row.
  const allowed = new Set(AGENT_ROLES);
  probeRoles = [...new Set(probeRoles.filter((r) => allowed.has(r)))];
  if (probeRoles.length === 0) return { ok: true, agentRoles: {} };

  // Cost optimisation: dedupe probes by resolved route id (or provider
  // id when no route exists yet — the AI-005 shim path). A workspace
  // with 7 roles all pointing at the same `provider_routes` row would
  // otherwise burn 7 paid API calls per crawl. We resolve each role's
  // route via `resolveRoute` (cheap — in-process state machine, same
  // path the dispatcher uses), bucket roles by route, probe ONE role
  // per route, then fan the result back out to every role in the
  // bucket. Roles that can't be resolved (route=null) get their own
  // bucket per role so each surfaces the `no_provider_configured`
  // reason in the result map.
  //
  // B2.3 change: bucketing on `routeId` (was `provider`) gives true
  // per-route granularity — two anthropic routes pointing at different
  // models legitimately get separate probes. The previous provider-
  // keyed bucket would have collapsed them into one.
  //
  // Trade-off: roles in the same bucket share the probe's `reason` field —
  // an Anthropic outage on one route looks identical for every role
  // assigned to that route. That's correct for "reachability" semantics;
  // per-role failure isolation only becomes meaningful when the route
  // assignments themselves differ.
  const buckets = new Map(); // dedupKey → { canonicalRole, roles[] }
  for (const role of probeRoles) {
    let dedupKey;
    const canonicalRole = role;
    try {
      const { route } = resolveRoute({ agentRole: role, workspaceId });
      if (route?.id) {
        // Real routes (`pr-...`) AND transient routes (`provider:...`)
        // both carry a stable id we can dedupe on. Two roles with the
        // same routeId share one probe; two roles with different routeIds
        // get their own.
        dedupKey = `route:${route.id}`;
      } else {
        dedupKey = `role:${role}`;
      }
    } catch {
      // resolveRoute can throw on misconfig (forced AI_PROVIDER pointing
      // at unknown id, or ERR_UNKNOWN_PROTOCOL on a legacy provider
      // value that's not in the protocolForProvider map). Fall back to
      // per-role probe so the error surfaces in the result map.
      dedupKey = `role:${role}`;
    }
    if (!buckets.has(dedupKey)) buckets.set(dedupKey, { canonicalRole, roles: [role] });
    else buckets.get(dedupKey).roles.push(role);
  }

  // Run probes in parallel — one per BUCKET, not per role. Bounded by
  // distinct providers (≤ AGENT_ROLES.length, typically 1–3 in practice).
  const bucketResults = await Promise.all(
    [...buckets.values()].map(async (b) => [b, await probeRole(workspaceId, b.canonicalRole, signal)]),
  );
  // Fan results back out to every role that mapped into the bucket so the
  // per-role result map shape stays unchanged for callers.
  const agentRoles = {};
  let allOk = true;
  for (const [bucket, result] of bucketResults) {
    for (const role of bucket.roles) agentRoles[role] = result;
    if (!result.ok) allOk = false;
  }
  return { ok: allOk, agentRoles };
}

/**
 * Convenience wrapper that throws `ERR_AGENT_HEALTH_CHECK_FAILED` when any
 * configured role fails its probe. The attached `agentRoles` property lets
 * the caller render the per-role failure breakdown.
 *
 * @param {string} workspaceId
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: true, agentRoles: Record<string, {ok: boolean, reason: string|null, provider: string|null}>}>}
 * @throws {Error} An Error with `code === "ERR_AGENT_HEALTH_CHECK_FAILED"` and an `agentRoles` property carrying the per-role probe result map.
 */
export async function assertAgentConfigsHealthy(workspaceId, opts = {}) {
  const result = await validateAgentConfigs(workspaceId, opts);
  if (!result.ok) {
    const failed = Object.entries(result.agentRoles)
      .filter(([, v]) => !v.ok)
      .map(([role, v]) => `${role}=${v.reason}`)
      .join(", ");
    const err = new Error(`Agent health check failed: ${failed}`);
    err.code = "ERR_AGENT_HEALTH_CHECK_FAILED";
    err.agentRoles = result.agentRoles;
    throw err;
  }
  return result;
}
