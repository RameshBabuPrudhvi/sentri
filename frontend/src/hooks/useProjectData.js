import { useEffect, useState, useMemo } from "react";
import { api } from "../api";

/**
 * Shared hook that fetches projects + tests + runs in parallel.
 *
 * Returns:
 *   projects  — project list
 *   allTests  — flat list of all tests across projects
 *   allRuns   — flat list of all runs (sorted newest-first), each enriched
 *               with projectId, projectName, projectUrl
 *   projMap   — { [projectId]: projectName }
 *   testRuns  — allRuns filtered to type === "test_run"
 *   loading   — true while initial fetch is in progress
 *
 * Options:
 *   fetchTests — also fetch tests per project (default true)
 *   fetchRuns  — also fetch runs per project (default true)
 */
export default function useProjectData({ fetchTests = true, fetchRuns = true } = {}) {
  const [projects, setProjects] = useState([]);
  const [allTests, setAllTests] = useState([]);
  const [allRuns, setAllRuns]   = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const projs = await api.getProjects();
        setProjects(projs);

        const promises = [];

        if (fetchRuns) {
          promises.push(
            Promise.all(projs.map(p =>
              api.getRuns(p.id)
                .then(rs => rs.map(r => ({ ...r, projectId: p.id, projectName: p.name, projectUrl: p.url })))
                .catch(() => [])
            )).then(r => r.flat())
          );
        } else {
          promises.push(Promise.resolve([]));
        }

        if (fetchTests) {
          promises.push(
            Promise.all(projs.map(p =>
              api.getTests(p.id).catch(() => [])
            )).then(t => t.flat())
          );
        } else {
          promises.push(Promise.resolve([]));
        }

        const [runs, tests] = await Promise.all(promises);
        setAllRuns(runs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
        setAllTests(tests);
      } catch (err) {
        console.error("useProjectData load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const projMap = useMemo(() =>
    Object.fromEntries(projects.map(p => [p.id, p.name])), [projects]);

  const testRuns = useMemo(() =>
    allRuns.filter(r => r.type === "test_run"), [allRuns]);

  return { projects, allTests, allRuns, testRuns, projMap, loading };
}
