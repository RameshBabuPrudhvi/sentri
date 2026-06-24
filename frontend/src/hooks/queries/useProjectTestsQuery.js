/**
 * @module hooks/queries/useProjectTestsQuery
 * @description Cached fetch of all tests for a project.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";

/**
 * @param {string|null|undefined} projectId
 * @returns {ReturnType<typeof useQuery>}
 */
export function useProjectTestsQuery(projectId) {
  return useQuery({
    queryKey: ["projectTests", projectId],
    queryFn: () => api.getTests(projectId),
    enabled: !!projectId,
  });
}
