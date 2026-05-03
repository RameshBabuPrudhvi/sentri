/**
 * @module utils/automationStatus
 * @description Pure parsers for the Automation page's status-chip data.
 *
 * Extracted from `useProjectStatus` (ProjectAutomationCard) and
 * `useQualityStatus` (ProjectConfigPanel) so the response-shape contract
 * with the backend can be unit-tested without rendering React.
 *
 * Each parser is defensive: null/undefined/error responses collapse to a
 * safe "not configured" value so a transient API failure never flips a
 * green chip to red.
 */

/**
 * Backend: `GET /projects/:id/trigger-tokens` → `{ tokens: [...] }`
 * Returns the count of issued tokens (0 on missing/invalid shape).
 */
export function parseTokenCount(data) {
  const list = data?.tokens ?? data ?? [];
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Backend: `GET /projects/:id/schedule` → `{ schedule: { enabled, ... } | null }`
 * Returns true only when a schedule exists *and* is enabled.
 */
export function parseHasSchedule(data) {
  return Boolean(data?.schedule?.enabled);
}

/**
 * Backend: `GET /projects/:id/quality-gates` → `{ qualityGates: { ... } | null }`
 * Returns true when at least one gate threshold is set to a non-empty value.
 */
export function parseHasGates(data) {
  const g = data?.qualityGates ?? {};
  if (!g || typeof g !== "object") return false;
  return Object.values(g).some(v => v !== null && v !== undefined && v !== "");
}

/**
 * Backend: `GET /projects/:id/web-vitals-budgets` → `{ webVitalsBudgets: { ... } | null }`
 * Returns true when at least one budget threshold is set to a non-empty value.
 */
export function parseHasBudgets(data) {
  const b = data?.webVitalsBudgets ?? {};
  if (!b || typeof b !== "object") return false;
  return Object.values(b).some(v => v !== null && v !== undefined && v !== "");
}

/**
 * Page-tab id whitelist used by `Automation.jsx` setActiveTab().
 * Exported so tests (and future deep-link parsers) share the same source of truth.
 */
export const PAGE_TAB_IDS = ["triggers", "quality", "integrations", "snippets"];

export function isValidPageTab(id) {
  return PAGE_TAB_IDS.includes(id);
}

/* ─── Cache invalidation (delegates to TanStack Query) ─────────────────────── */

import { queryClient, automationStatusQueryKeys } from "../queryClient.js";

/**
 * Drop cached automation-status queries for a project so subscribed
 * `useAutomationStatusQuery` consumers refetch. Pass `kind` to invalidate
 * a single kind; omit to invalidate every kind for the project.
 *
 * Per STANDARDS.md, all cached GETs flow through the shared `queryClient`
 * — this is a thin wrapper so mutation sites (TokenManager, ScheduleManager,
 * ConfigurablePanel) keep using the same name they did before the migration.
 *
 * @param {string} projectId
 * @param {"tokens"|"schedule"|"gates"|"budgets"} [kind]
 * @returns {Promise<void>}
 */
export function invalidateAutomationStatus(projectId, kind) {
  const queryKey = kind
    ? automationStatusQueryKeys.kind(projectId, kind)
    : automationStatusQueryKeys.project(projectId);
  return queryClient.invalidateQueries({ queryKey });
}
