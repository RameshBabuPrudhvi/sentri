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
 * Canonical AI-005 agent role names. Matches the eight-role bounded label set
 * the metrics layer assumes (8 × 5 providers × 3 outcomes ≈ 120 series). New
 * roles must be added here AND in the pipeline caller list in NEXT.md before
 * they appear in `agent_configs`.
 *
 * @type {readonly string[]}
 */
export const AGENT_ROLES = Object.freeze([
  "explorer",
  "planner",
  "author",
  "oracle",
  "reviewer",
  "healer",
  "triager",
  "default",
]);

/**
 * Issue a 1-token probe call against one (workspaceId, role) pair.
 *
 * @param {string} workspaceId
 * @param {string} role
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, reason: string|null, provider: string|null}>}
 */
async function probeRole(workspaceId, role, signal) {
  // First resolve so we can report which provider would have been used even
  // when the probe call fails. `resolveProvider` returns `{ provider: null }`
  // when nothing is usable — surface that as a config error, not a network
  // failure.
  const { provider } = resolveProvider({ agentRole: role, workspaceId });
  if (!provider) {
    return { ok: false, reason: "no_provider_configured", provider: null };
  }
  try {
    await generateText("ping", { agentRole: role, workspaceId, maxTokens: 1, signal });
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
 * @throws {Error & {code: "ERR_AGENT_HEALTH_CHECK_FAILED", agentRoles: object}}
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
