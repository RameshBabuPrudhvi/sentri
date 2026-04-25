/**
 * @module hooks/queries/useRunDetailQuery
 * @description Cached fetch of a single run's detail. SSE updates apply
 * optimistic patches into this query's cache via queryClient.setQueryData()
 * — see RunDetail.jsx.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";
import { runQueryKeys } from "../../queryClient.js";

// Run detail benefits from a slightly tighter cache than the global default
// because SSE-driven optimistic patches are the primary freshness mechanism
// while the run is active.
const RUN_STALE_TIME_MS = 5_000;
const RUN_GC_TIME_MS = 60_000;

/**
 * @param {string} runId
 * @returns {ReturnType<typeof useQuery>}
 */
export function useRunDetailQuery(runId) {
  return useQuery({
    queryKey: runQueryKeys.detail(runId),
    queryFn: () => api.getRun(runId),
    staleTime: RUN_STALE_TIME_MS,
    gcTime: RUN_GC_TIME_MS,
  });
}
