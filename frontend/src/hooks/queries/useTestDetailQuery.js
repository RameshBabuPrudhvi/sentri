/**
 * @module hooks/queries/useTestDetailQuery
 * @description Cached fetch of a single test's detail + its project + project runs.
 * Returns a composite `{ test, project, runs }` object so the page can read
 * everything from one query.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";
import { testQueryKeys } from "../../queryClient.js";

/**
 * @param {string} testId
 * @returns {ReturnType<typeof useQuery>}
 */
export function useTestDetailQuery(testId) {
  return useQuery({
    queryKey: testQueryKeys.detail(testId),
    queryFn: async () => {
      const test = await api.getTest(testId);
      const [project, projectRuns] = await Promise.all([
        api.getProject(test.projectId).catch(() => null),
        api.getRuns(test.projectId).catch(() => []),
      ]);
      // Filter to runs that include this test
      const runs = projectRuns.filter((run) =>
        run.type === "test_run" &&
        (run.tests?.includes(testId) ||
         run.results?.some((res) => res.testId === testId))
      );
      return { test, project, runs };
    },
    enabled: !!testId,
  });
}
