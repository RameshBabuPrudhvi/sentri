/**
 * @module hooks/useProjectEnvironments
 * @description Loads the per-project environment list (DIF-012) when the
 *   selected project changes. Returns `[environments, environmentId,
 *   setEnvironmentId]` so callers can render the env picker without
 *   owning the fetch lifecycle.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` (audit §3.1, pass 3).
 *
 * Notes:
 *   - Viewer roles get a 403 from `GET /api/v1/projects/:id/environments`.
 *     We swallow it so the picker hides itself when the list is empty —
 *     matches the existing behaviour (`.catch(() => setEnvironments([]))`).
 *   - `environmentId === ""` is the sentinel for "default — use
 *     project.url"; callers omit the field from the launch payload when
 *     unset. Reset to "" whenever `projectId` changes so a stale id from
 *     a previous project doesn't leak across the switch.
 *   - `cancelled` flag guards against the React StrictMode double-mount
 *     + the fast project-switch race (user clicks A then B before A's
 *     fetch resolves).
 *
 * @param {string|null|undefined} projectId
 * @returns {[Array, string, (id: string) => void]}
 */
import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function useProjectEnvironments(projectId) {
  const [environments, setEnvironments] = useState([]);
  const [environmentId, setEnvironmentId] = useState("");

  useEffect(() => {
    if (!projectId) {
      setEnvironments([]);
      setEnvironmentId("");
      return;
    }
    let cancelled = false;
    // Reset on every project change — a stale environmentId from the
    // previous project would otherwise be sent to the new project's
    // launch endpoint and 404 on the lookup.
    setEnvironmentId("");
    api.getProjectEnvironments(projectId)
      .then((rows) => { if (!cancelled) setEnvironments(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setEnvironments([]); }); // 403 for viewers — clutter-free
    return () => { cancelled = true; };
  }, [projectId]);

  return [environments, environmentId, setEnvironmentId];
}
