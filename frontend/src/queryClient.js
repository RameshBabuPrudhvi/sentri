/**
 * @module queryClient
 * @description Shared TanStack Query client and query keys.
 */

import { QueryClient, QueryCache } from "@tanstack/react-query";

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

/**
 * Format a query key array into a stable log label.
 * Skips the dynamic params object on `projectDetail` so similar failures
 * collapse into a single signature.
 *
 * @param {Array} queryKey
 * @returns {string}
 */
function formatQueryLabel(queryKey) {
  return queryKey
    .filter((part) => typeof part === "string" || typeof part === "number")
    .join(":");
}

export const queryClient = new QueryClient({
  // Centralised error handler — fires once per query AFTER retries are
  // exhausted, so we don't log the same failure on every retry attempt.
  // This replaces per-component `useEffect`-based logging that was prone
  // to render-body misuse and Strict Mode double-firing.
  queryCache: new QueryCache({
    onError: (error, query) => {
      const label = formatQueryLabel(query.queryKey);
      // Use console.warn for "expected" recoverable errors (4xx, network blips)
      // and console.error for programming failures. We can't reliably tell
      // them apart from a fetch promise rejection, so default to error.
      console.error(`[query] ${label} failed:`, error?.message || error);
    },
  }),
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
 * @returns {Promise<void>} Resolves once the matching queries finish refetching,
 *   so callers can `await` to defer follow-up UI changes (toasts, navigation,
 *   tour events) until the cache is fresh.
 */
export function invalidateDashboardCache() {
  return queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.root });
}

/**
 * Bust the cached run-detail query for a given run ID. Call after mutations
 * that change run state (abort, re-run, manual refresh).
 *
 * @param {string} runId
 * @returns {Promise<void>} See {@link invalidateDashboardCache}.
 */
export function invalidateRunCache(runId) {
  return queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) });
}

/**
 * Bust every settings-related cached query (bundle, members, recycleBin,
 * ollamaStatus). Call after mutations that affect settings or workspace state.
 *
 * @returns {Promise<void>} See {@link invalidateDashboardCache}. `Settings.jsx`
 *   relies on this so `await reload()` actually waits for the bundle refetch
 *   before the post-save UI advances (sysInfo counts, tour event dispatch).
 */
export function invalidateSettingsCache() {
  return queryClient.invalidateQueries({ queryKey: settingsQueryKeys.root });
}
