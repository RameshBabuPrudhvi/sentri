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
import { resolveProvider } from "./registry.js";

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
  // The try/catch wraps BOTH `resolveProvider` and `generateText` because
  // `resolveProvider` itself can throw (e.g. forced `AI_PROVIDER` pointing
  // at an unknown id surfaces as a synchronous throw from `detectProvider`).
  // Without this wrapper, the throw would propagate through `Promise.all`
  // in `validateAgentConfigs` and abandon the probe results for every
  // other role — converting a one-role config error into a total
  // health-check failure for the workspace.
  let provider = null;
  try {
    // Resolve first so we can report which provider would have been used
    // even when the probe call fails. `resolveProvider` returns
    // `{ provider: null }` when nothing is usable — surface that as a
    // config error, not a network failure.
    ({ provider } = resolveProvider({ agentRole: role, workspaceId }));
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
      reason: err?.code || err?.message?.slice(0, 200) || "probe_failed",
      provider,
    };
  }
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
  // Run probes in parallel — bounded by `probeRoles.length` which is capped at
  // AGENT_ROLES.length so there's no need for a concurrency limiter.
  const entries = await Promise.all(
    probeRoles.map(async (role) => [role, await probeRole(workspaceId, role, signal)]),
  );
  const agentRoles = Object.fromEntries(entries);
  const ok = entries.every(([, v]) => v.ok);
  return { ok, agentRoles };
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
