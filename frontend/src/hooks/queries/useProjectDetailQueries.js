/**
 * @module hooks/queries/useProjectDetailQueries
 * @description Cached fetches for the Project Detail page — composite (project +
 * paged tests + paged runs + counts) and the on-demand traceability tab.
 */

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "../../api.js";
import { projectDetailQueryKeys } from "../../queryClient.js";

const PAGE_SIZE = 10;

/**
 * Composite fetch: project + paged tests + paged runs + counts. The query key
 * includes every filter input so React Query refetches automatically when
 * any of them change.
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {number} params.reviewPage
 * @param {number} params.runsPage
 * @param {string} params.reviewFilter
 * @param {string} params.categoryFilter
 * @param {string} params.search
 * @returns {ReturnType<typeof useQuery>}
 */
export function useProjectDetailQuery({
  projectId,
  reviewPage,
  runsPage,
  reviewFilter,
  categoryFilter,
  search,
}) {
  return useQuery({
    queryKey: projectDetailQueryKeys.detail(projectId, {
      reviewPage, runsPage, reviewFilter, categoryFilter, search,
    }),
    queryFn: async () => {
      const filters = {};
      if (reviewFilter && reviewFilter !== "all") filters.reviewStatus = reviewFilter;
      if (categoryFilter && categoryFilter !== "all") filters.category = categoryFilter;
      if (search) filters.search = search;

      const [project, tRes, rRes, counts] = await Promise.all([
        api.getProject(projectId),
        api.getTestsPaged(projectId, reviewPage, PAGE_SIZE, filters),
        api.getRunsPaged(projectId, runsPage, PAGE_SIZE),
        api.getTestCounts(projectId),
      ]);
      return {
        project,
        tests: tRes.data,
        testsMeta: tRes.meta,
        runs: rRes.data,
        runsMeta: rRes.meta,
        testCounts: counts,
      };
    },
    enabled: !!projectId,
    // Keep previous data visible while paging/filtering so the table doesn't
    // flash to "loading" on every keystroke / page click.
    placeholderData: keepPreviousData,
  });
}

/**
 * Lazy traceability fetch — only enabled when the user opens that tab.
 *
 * @param {string} projectId
 * @param {boolean} enabled
 * @returns {ReturnType<typeof useQuery>}
 */
export function useTraceabilityQuery(projectId, enabled) {
  return useQuery({
    queryKey: projectDetailQueryKeys.traceability(projectId),
    queryFn: () => api.getTraceability(projectId),
    enabled: !!projectId && !!enabled,
  });
}
