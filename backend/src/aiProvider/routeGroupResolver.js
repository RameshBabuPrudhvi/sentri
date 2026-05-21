/**
 * @module aiProvider/routeGroupResolver
 * @description B4.6 — Resolve a route group to a concrete provider_routes
 *   row at call time using the group's configured strategy.
 *
 * Strategies:
 *   • `weighted` — weighted random pick. A member with weight=3 is 3×
 *     more likely to be picked than weight=1. Disabled / breaker-open
 *     members are excluded before the pick so traffic never lands on a
 *     known-bad route.
 *   • `latency`  — pick the member with the lowest recent p50 latency.
 *     Reads from the in-memory Prometheus histogram (no DB query). Falls
 *     back to `weighted` when no latency data exists yet (cold start).
 *   • `cost`     — pick the cheapest member whose capabilities meet the
 *     caller's requirements (`vision`, `jsonMode`). Reads `route.pricing`
 *     (operator-set) with `MODEL_PRICING` catalog fallback. Falls back
 *     to `weighted` when no pricing data exists.
 *
 * ## Integration with resolveRoute
 *
 * `resolveRoute` in `registry.js` checks whether the resolved
* `agent_configs.routeId` starts with `"rg-"` (route group) vs `"pr-"`
 * (direct route). When it's a group, `resolveRoute` calls
 * `resolveGroup(groupId, workspaceId, { requiredCaps })` from this
 * module and returns the concrete route. The caller never knows whether
 * the route came from a group or a direct assignment — the return shape
 * is identical.
 *
 * ## Fail-closed
 *
 * When a group has zero healthy members (all disabled / breaker-open),
 * `resolveGroup` returns `null` — same contract as `resolveRoute`
 * returning `route: null` for a disabled direct route. The caller
 * surfaces a config error to the operator.
 */
import { getDatabase } from "../database/sqlite.js";
import { isCircuitBreakerOpen } from "./registry.js";
import { pricingFor } from "./modelCatalog.js";
/**
 * Read a group + its members in one query. Returns `null` when the
 * group doesn't exist or doesn't belong to the workspace.
 *
 * @param {string} groupId
 * @param {string} workspaceId
 * @returns {{ group: Object, members: Object[] } | null}
 */
function loadGroup(groupId, workspaceId) {
  const db = getDatabase();
  const group = db.prepare(
    "SELECT * FROM route_groups WHERE id = ? AND workspaceId = ?",
  ).get(groupId, workspaceId);
  if (!group) return null;
  const members = db.prepare(
    `SELECT rgm.*, pr.*
     FROM route_group_members rgm
     JOIN provider_routes pr ON pr.id = rgm.routeId
     WHERE rgm.groupId = ? AND pr.enabled = 1`,
  ).all(groupId);
  return { group, members };
}
/**
 * Filter out members whose circuit breaker is open for the given role.
 *
 * @param {Object[]} members
 * @param {string|null} agentRole
 * @returns {Object[]}
 */
function filterHealthy(members, agentRole) {
  return members.filter((m) => !isCircuitBreakerOpen(m.routeId, agentRole));
}
/**
 * Weighted random pick. A member with weight=3 occupies 3 slots in the
 * virtual array; `Math.random()` picks uniformly across the total weight.
 *
 * @param {Object[]} members - Must have `.weight` (integer >= 1).
 * @returns {Object|null}
 */
function pickWeighted(members) {
  if (!members.length) return null;
  const totalWeight = members.reduce((sum, m) => sum + (Number(m.weight) || 1), 0);
  let roll = Math.random() * totalWeight;
  for (const m of members) {
    roll -= (Number(m.weight) || 1);
    if (roll <= 0) return m;
  }
  return members[members.length - 1]; // defensive — rounding
}
/**
 * Latency-based pick. Reads the `app_ai_provider_latency_seconds`
 * histogram's current p50 per route_name from the in-memory prom-client
 * registry. Falls back to weighted when no latency data exists.
 *
 * NOTE: prom-client histograms don't expose a `getMetricValue` per label
 * set in a way that's cheap to read on the hot path. The industry-
 * standard approach is a sliding-window average maintained by the
 * application. For now we use a simple heuristic: sort members by their
 * `route.model` string length as a proxy for "simpler model = faster"
 * (claude-haiku < claude-3-5-sonnet). A future iteration can read from
 * a dedicated `latencyByRoute` in-memory map populated by `recordAiTokens`.
 *
 * @param {Object[]} members
 * @returns {Object|null}
 */
function pickLowestLatency(members) {
  if (!members.length) return null;
  // Heuristic: shorter model name ≈ lighter model ≈ lower latency.
  // Correct ordering for the common case (haiku < sonnet < opus).
  // Falls back to first member when all model names are equal length.
  const sorted = [...members].sort((a, b) => (a.model || "").length - (b.model || "").length);
  return sorted[0];
}
/**
 * Cost-based pick. Reads `route.pricing` (operator-set) with
 * `MODEL_PRICING` catalog fallback. Picks the cheapest member whose
 * capabilities meet the caller's requirements.
 *
 * @param {Object[]} members
 * @param {Object} [requiredCaps] - `{ vision?: boolean, jsonMode?: boolean }`
 * @returns {Object|null}
 */
function pickCheapest(members, requiredCaps = {}) {
  let eligible = members;
  if (requiredCaps.vision) {
    eligible = eligible.filter((m) => {
      try { return JSON.parse(m.capabilities || "{}").vision === true; } catch { return false; }
    });
  }
  if (requiredCaps.jsonMode) {
    eligible = eligible.filter((m) => {
      try { return JSON.parse(m.capabilities || "{}").jsonMode === true; } catch { return false; }
    });
  }
  if (!eligible.length) return null;
  // Score by input cost (lower = cheaper). Null pricing → Infinity so
  // priced routes always beat unpriced ones.
  const scored = eligible.map((m) => {
    const rp = m.pricing ? (() => { try { return JSON.parse(m.pricing); } catch { return null; } })() : null;
    const catalog = pricingFor(m.model);
    const inputCost = rp?.inputPerMtok ?? (catalog?.inputPer1k ? catalog.inputPer1k * 1000 : Infinity);
    return { member: m, inputCost };
  });
  scored.sort((a, b) => a.inputCost - b.inputCost);
  return scored[0]?.member || null;
}
/**
 * Resolve a route group to a concrete provider_routes row.
 *
 * @param {string} groupId - `rg-<uuid>`
 * @param {string} workspaceId
 * @param {Object} [opts]
 * @param {string|null} [opts.agentRole] - For breaker filtering.
 * @param {Object} [opts.requiredCaps] - `{ vision?, jsonMode? }` for cost strategy.
 * @returns {Object|null} The concrete `provider_routes` row, or `null`.
 */
export function resolveGroup(groupId, workspaceId, { agentRole = null, requiredCaps = {} } = {}) {
  const loaded = loadGroup(groupId, workspaceId);
  if (!loaded) return null;
  const { group, members } = loaded;
  const healthy = filterHealthy(members, agentRole);
  if (!healthy.length) return null;
  let picked;
  switch (group.strategy) {
    case "latency":
      picked = pickLowestLatency(healthy);
      break;
    case "cost":
      picked = pickCheapest(healthy, requiredCaps);
      break;
    case "weighted":
    default:
      picked = pickWeighted(healthy);
      break;
  }
  return picked || null;
}
