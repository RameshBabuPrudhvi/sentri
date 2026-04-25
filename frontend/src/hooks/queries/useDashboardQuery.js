/**
 * @module hooks/queries/useDashboardQuery
 * @description Cached fetch of the dashboard summary endpoint.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";
import { dashboardQueryKeys } from "../../queryClient.js";

/**
 * @returns {ReturnType<typeof useQuery>}
 */
export function useDashboardQuery() {
  return useQuery({
    queryKey: dashboardQueryKeys.summary,
    queryFn: api.getDashboard,
  });
}
