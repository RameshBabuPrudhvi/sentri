/**
 * @module hooks/useProjectData
 * @description Shared TanStack Query hook for projects, tests, and runs.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryClient, projectDataQueryKeys } from "../queryClient";

const STALE_TIME_MS = 30_000;

/**
 * Bust cached project data queries. Call after mutations (create/delete project,
 * approve/reject tests, etc.) so the next render fetches fresh data.
 *
 * @returns {void}
 */
export function invalidateProjectDataCache() {
  queryClient.invalidateQueries({ queryKey: projectDataQueryKeys.root });
}

/**
 * Fetch all runs for the provided projects and enrich them for UI use.
 *
 * @param {Array<{ id: string, name: string, url: string }>} projects - Project list.
 * @returns {Promise<Array>} Enriched run list sorted newest-first.
 */
async function fetchProjectRuns(projects) {
  const allRuns = await Promise.all(
    projects.map((project) =>
      api.getRuns(project.id)
        .then((runs) =>
          runs.map((run) => ({
            ...run,
            projectId: project.id,
            projectName: project.name,
            projectUrl: project.url,
          }))
        )
        .catch(() => [])
    )
  );

  return allRuns
    .flat()
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

/**
 * Fetch tests with batch endpoint fallback to per-project endpoint.
 *
 * @param {Array<{ id: string }>} projects - Project list.
 * @returns {Promise<Array>} Flattened tests.
 */
async function fetchProjectTests(projects) {
  try {
    return await api.getAllTests();
  } catch {
    const testsByProject = await Promise.all(
      projects.map((project) => api.getTests(project.id).catch(() => []))
    );
    return testsByProject.flat();
  }
}

/**
 * Shared hook that fetches projects, tests, and runs in parallel with query caching.
 *
 * @param {Object}  [options]
 * @param {boolean} [options.fetchTests=true] - Also fetch tests per project.
 * @param {boolean} [options.fetchRuns=true]  - Also fetch runs per project.
 * @returns {UseProjectDataResult}
 *
 * @typedef {Object} UseProjectDataResult
 * @property {Array}   projects  - Project list.
 * @property {Array}   allTests  - Flat list of all tests across projects.
 * @property {Array}   allRuns   - Flat list of all runs (sorted newest-first), enriched with `projectId`, `projectName`, `projectUrl`.
 * @property {Array}   testRuns  - `allRuns` filtered to `type === "test_run"`.
 * @property {Object}  projMap   - `{ [projectId]: projectName }`.
 * @property {boolean} loading   - `true` while initial fetch is in progress.
 * @property {Function} refresh  - Call to force a fresh fetch.
 */
export default function useProjectData({ fetchTests = true, fetchRuns = true } = {}) {
  const projectsQuery = useQuery({
    queryKey: projectDataQueryKeys.projects,
    queryFn: api.getProjects,
    staleTime: STALE_TIME_MS,
    gcTime: STALE_TIME_MS,
    retry: 1,
  });

  const projects = projectsQuery.data || [];

  const projectIds = useMemo(
    () => projects.map((project) => project.id).sort(),
    [projects]
  );

  const runsQuery = useQuery({
    queryKey: [...projectDataQueryKeys.runs, projectIds],
    queryFn: () => fetchProjectRuns(projects),
    enabled: fetchRuns && projects.length > 0,
    staleTime: STALE_TIME_MS,
    gcTime: STALE_TIME_MS,
    retry: 1,
  });

  const testsQuery = useQuery({
    queryKey: [...projectDataQueryKeys.tests, projectIds],
    queryFn: () => fetchProjectTests(projects),
    enabled: fetchTests && projects.length > 0,
    staleTime: STALE_TIME_MS,
    gcTime: STALE_TIME_MS,
    retry: 1,
  });

  const allRuns = fetchRuns ? (runsQuery.data || []) : [];
  const allTests = fetchTests ? (testsQuery.data || []) : [];

  const projMap = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects]
  );

  const testRuns = useMemo(
    () => allRuns.filter((run) => run.type === "test_run"),
    [allRuns]
  );

  const loading = Boolean(
    projectsQuery.isLoading ||
    (fetchRuns && runsQuery.isLoading) ||
    (fetchTests && testsQuery.isLoading)
  );

  return {
    projects,
    allTests,
    allRuns,
    testRuns,
    projMap,
    loading,
    refresh: () => invalidateProjectDataCache(),
  };
}
