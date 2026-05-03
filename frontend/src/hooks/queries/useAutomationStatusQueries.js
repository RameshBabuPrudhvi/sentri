/**
 * @module hooks/queries/useAutomationStatusQueries
 * @description Cached fetches for the Automation page's per-project status
 * chips. Each kind (tokens / schedule / gates / budgets) is its own query
 * so a mutation in one section doesn't refetch unrelated chips.
 *
 * Replaces the previous module-level Map cache + pub/sub bus that lived in
 * `utils/automationStatus.js` (PR #6 review feedback — bypassed `queryClient`
 * and contradicted STANDARDS.md "All cached GETs go through TanStack Query").
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";
import { automationStatusQueryKeys } from "../../queryClient.js";
import {
  parseTokenCount,
  parseHasSchedule,
  parseHasGates,
  parseHasBudgets,
} from "../../utils/automationStatus.js";

/** Maps each status kind to its API fetcher + parser. */
const KIND_CONFIG = {
  tokens:   { fetch: (pid) => api.getTriggerTokens(pid),   parse: parseTokenCount,  fallback: 0     },
  schedule: { fetch: (pid) => api.getSchedule(pid),        parse: parseHasSchedule, fallback: false },
  gates:    { fetch: (pid) => api.getQualityGates(pid),    parse: parseHasGates,    fallback: false },
  budgets:  { fetch: (pid) => api.getWebVitalsBudgets(pid), parse: parseHasBudgets,  fallback: false },
};

/**
 * Fetch + parse a single automation-status kind for a project. Returns the
 * parsed value (token count for `tokens`, boolean for the rest) directly via
 * `select`, so consumers don't need to call the parser themselves. Errors
 * collapse to a safe "not configured" fallback so a transient API failure
 * never flips a green chip to red.
 *
 * @param {string} projectId
 * @param {"tokens"|"schedule"|"gates"|"budgets"} kind
 * @returns {{ data: number|boolean|null, isLoading: boolean }}
 */
export function useAutomationStatusQuery(projectId, kind) {
  const config = KIND_CONFIG[kind];
  const query = useQuery({
    queryKey: automationStatusQueryKeys.kind(projectId, kind),
    queryFn: () => config.fetch(projectId),
    enabled: !!projectId,
    select: (data) => config.parse(data),
  });

  // Match the pre-migration "fail-soft" contract: never expose an error state
  // to the chip — a fetch failure just means "not configured".
  return {
    data: query.isError ? config.fallback : (query.data ?? null),
    isLoading: query.isLoading,
  };
}
