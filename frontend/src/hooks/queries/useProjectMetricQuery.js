/**
 * @module hooks/queries/useProjectMetricQuery
 * @description TanStack Query wrapper around `api.getProjectMetric` —
 * fetches a single time-series for a project's metric key (MET-001 +
 * AUTO-017.3). Used by `QualityGatesSection`'s Web Vitals block
 * (`features/project-settings/sections/quality-gates/QualityGatesSection.jsx`)
 * to feed the four `<TrendChart>` instances (LCP / CLS / INP / TTFB).
 *
 * The query returns the raw `samples` array (already shaped as
 * `[{ ts, value, tags }, ...]`) so call sites can pass it directly to
 * `<TrendChart samples={...} />` without an intermediate `select`.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";

/**
 * @param {string} projectId
 * @param {string} metricKey - e.g. `"webVitals.lcp"`.
 * @param {Object} [opts]
 * @param {number} [opts.since]
 * @param {number} [opts.limit]
 * @returns {{ data: Array<{ts: number, value: number, tags: Object|null}>, isLoading: boolean, isError: boolean }}
 */
export function useProjectMetricQuery(projectId, metricKey, opts = {}) {
  const query = useQuery({
    queryKey: ["projectMetric", projectId, metricKey, opts.since ?? 0, opts.limit ?? 200],
    queryFn: () => api.getProjectMetric(projectId, metricKey, opts),
    enabled: !!projectId && !!metricKey,
    select: (data) => data?.samples ?? [],
  });

  // Fail-soft: a transient API failure shouldn't replace the chart with
  // an error banner — render an empty trend instead, matching how
  // `useAutomationStatusQuery` collapses errors to a "not configured"
  // fallback in the same surface.
  return {
    data: query.isError ? [] : (query.data ?? []),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
