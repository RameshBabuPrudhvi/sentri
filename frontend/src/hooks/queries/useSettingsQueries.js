/**
 * @module hooks/queries/useSettingsQueries
 * @description Cached settings-related queries used by the Settings page.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../../api.js";
import { settingsQueryKeys } from "../../queryClient.js";

/**
 * Bundled fetch of settings + config + system info.
 * @returns {ReturnType<typeof useQuery>}
 */
export function useSettingsBundleQuery() {
  return useQuery({
    queryKey: settingsQueryKeys.bundle,
    queryFn: async () => {
      const [s, c, sys] = await Promise.all([
        api.getSettings(),
        api.getConfig(),
        api.getSystemInfo().catch(() => null),
      ]);
      return { settings: s, config: c, sysInfo: sys };
    },
  });
}

/**
 * @returns {ReturnType<typeof useQuery>}
 */
export function useMembersQuery() {
  return useQuery({
    queryKey: settingsQueryKeys.members,
    queryFn: api.getMembers,
  });
}

/**
 * @returns {ReturnType<typeof useQuery>}
 */
export function useRecycleBinQuery() {
  return useQuery({
    queryKey: settingsQueryKeys.recycleBin,
    queryFn: api.getRecycleBin,
  });
}

/**
 * Ollama status — converts thrown errors into a stable `{ ok: false, error }`
 * shape so the UI can render `status.error` without React Query treating it
 * as an error state.
 *
 * @returns {ReturnType<typeof useQuery>}
 */
export function useOllamaStatusQuery() {
  return useQuery({
    queryKey: settingsQueryKeys.ollamaStatus,
    queryFn: () => api.getOllamaStatus().catch((err) => ({ ok: false, error: err.message })),
    staleTime: 15_000,
  });
}
