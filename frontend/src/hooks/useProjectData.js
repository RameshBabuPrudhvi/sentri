import { useEffect, useState, useMemo, useRef } from "react";
import { api } from "../api";

// module-level cache with 30s TTL — survives component unmount/remount
// so navigating Projects → Tests → Projects doesn't refetch everything
const CACHE_TTL = 30_000;
const cache = {
  projects:  { data: null, ts: 0 },
  runs:      { data: null, ts: 0 },
  tests:     { data: null, ts: 0 },
};

function isFresh(entry) {
  return entry.data !== null && Date.now() - entry.ts < CACHE_TTL;
}

function setCache(key, data) {
  cache[key] = { data, ts: Date.now() };
}

// Exported so other components (e.g. after mutations) can bust the cache
export function invalidateProjectDataCache() {
  cache.projects.ts = 0;
  cache.runs.ts     = 0;
  cache.tests.ts    = 0;
}

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
 *   refresh   — call to force a fresh fetch (busts cache)
 *
 * Options:
 *   fetchTests — also fetch tests per project (default true)
 *   fetchRuns  — also fetch runs per project (default true)
 */
export default function useProjectData({ fetchTests = true, fetchRuns = true } = {}) {
  const [projects, setProjects] = useState(() => cache.projects.data || []);
  const [allTests, setAllTests] = useState(() => cache.tests.data   || []);
  const [allRuns,  setAllRuns]  = useState(() => cache.runs.data    || []);
  // Start as not-loading if we already have fresh cache data
  const [loading, setLoading]   = useState(
    !isFresh(cache.projects) ||
    (fetchRuns  && !isFresh(cache.runs))  ||
    (fetchTests && !isFresh(cache.tests))
  );
  const mountedRef = useRef(true);

  async function load(bust = false) {
    if (bust) invalidateProjectDataCache();

    try {
      // Projects
      let projs;
      if (!bust && isFresh(cache.projects)) {
        projs = cache.projects.data;
      } else {
        projs = await api.getProjects();
        setCache("projects", projs);
      }
      if (mountedRef.current) setProjects(projs);

      const promises = [];

      // Runs
      if (fetchRuns) {
        if (!bust && isFresh(cache.runs)) {
          promises.push(Promise.resolve(cache.runs.data));
        } else {
          promises.push(
            Promise.all(
              projs.map(p =>
                api.getRuns(p.id)
                  .then(rs => rs.map(r => ({ ...r, projectId: p.id, projectName: p.name, projectUrl: p.url })))
                  .catch(() => [])
              )
            ).then(r => {
              const flat = r.flat().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
              setCache("runs", flat);
              return flat;
            })
          );
        }
      } else {
        // Preserve cached data when not fetching — don't overwrite state with []
        promises.push(Promise.resolve(cache.runs.data || []));
      }

      // Tests — try batch endpoint first (Fix #26), fall back to per-project
      if (fetchTests) {
        if (!bust && isFresh(cache.tests)) {
          promises.push(Promise.resolve(cache.tests.data));
        } else {
          promises.push(
            api.getAllTests()
              .catch(() =>
                Promise.all(projs.map(p => api.getTests(p.id).catch(() => []))).then(t => t.flat())
              )
              .then(tests => {
                setCache("tests", tests);
                return tests;
              })
          );
        }
      } else {
        promises.push(Promise.resolve([]));
      }

      const [runs, tests] = await Promise.all(promises);
      if (mountedRef.current) {
        setAllRuns(runs);
        setAllTests(tests);
      }
    } catch (err) {
      console.error("useProjectData load error:", err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const needsFetch =
      !isFresh(cache.projects) ||
      (fetchRuns  && !isFresh(cache.runs))  ||
      (fetchTests && !isFresh(cache.tests));

    if (needsFetch) {
      setLoading(true);
      load();
    }
    return () => { mountedRef.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const projMap = useMemo(
    () => Object.fromEntries(projects.map(p => [p.id, p.name])),
    [projects]
  );

  const testRuns = useMemo(
    () => allRuns.filter(r => r.type === "test_run"),
    [allRuns]
  );

  return {
    projects, allTests, allRuns, testRuns, projMap, loading,
    refresh: () => { setLoading(true); load(true); },
  };
}
