/**
 * @module queryClient
 * @description Shared TanStack Query client and query keys.
 */

import { QueryClient } from "@tanstack/react-query";

export const projectDataQueryKeys = {
  root: ["projectData"],
  projects: ["projectData", "projects"],
  runs: ["projectData", "runs"],
  tests: ["projectData", "tests"],
};

export const dashboardQueryKeys = {
  root: ["dashboard"],
  summary: ["dashboard", "summary"],
};

export const runQueryKeys = {
  root: ["run"],
  /**
   * @param {string} runId
   * @returns {Array}
   */
  detail: (runId) => ["run", "detail", runId],
};

export const testQueryKeys = {
  root: ["test"],
  /**
   * @param {string} testId
   * @returns {Array}
   */
  detail: (testId) => ["test", "detail", testId],
};

export const projectDetailQueryKeys = {
  root: ["projectDetail"],
  /**
   * @param {string} projectId
   * @param {Object} params - paging + filter inputs
   * @returns {Array}
   */
  detail: (projectId, params) => ["projectDetail", projectId, params],
  traceability: (projectId) => ["projectDetail", projectId, "traceability"],
};

export const settingsQueryKeys = {
  root: ["settings"],
  bundle: ["settings", "bundle"], // settings + config + system info
  members: ["settings", "members"],
  recycleBin: ["settings", "recycleBin"],
  ollamaStatus: ["settings", "ollamaStatus"],
};

/** Default cache window for almost every query in the app (30 seconds). */
export const DEFAULT_STALE_TIME_MS = 30_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: DEFAULT_STALE_TIME_MS,
      gcTime: DEFAULT_STALE_TIME_MS,
    },
  },
});

/**
 * Bust the cached dashboard query. Call after mutations that affect dashboard
 * metrics (run completion, test approval, project deletion) so the next render
 * fetches fresh data.
 *
 * @returns {void}
 */
export function invalidateDashboardCache() {
  queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.root });
}

/**
 * Bust the cached run-detail query for a given run ID. Call after mutations
 * that change run state (abort, re-run, manual refresh).
 *
 * @param {string} runId
 * @returns {void}
 */
export function invalidateRunCache(runId) {
  queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) });
}

/**
 * Bust every settings-related cached query (bundle, members, recycleBin,
 * ollamaStatus). Call after mutations that affect settings or workspace state.
 *
 * @returns {void}
 */
export function invalidateSettingsCache() {
  queryClient.invalidateQueries({ queryKey: settingsQueryKeys.root });
}
