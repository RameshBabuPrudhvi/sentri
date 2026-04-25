/**
 * @module tests/query-client
 * @description Unit tests for the shared TanStack Query client and project data query keys.
 *
 * Verifies:
 *  - projectDataQueryKeys shape and hierarchy.
 *  - queryClient default options (no window-focus refetch, retry once).
 *  - Invalidating the `root` key invalidates all child queries (projects/runs/tests),
 *    which is the contract `invalidateProjectDataCache()` relies on.
 */

import assert from "node:assert/strict";

(async () => {
  try {
    const { queryClient, projectDataQueryKeys } = await import("../src/queryClient.js");

    // ── Query keys shape ──────────────────────────────────────────────
    assert.deepEqual(projectDataQueryKeys.root, ["projectData"]);
    assert.deepEqual(projectDataQueryKeys.projects, ["projectData", "projects"]);
    assert.deepEqual(projectDataQueryKeys.runs, ["projectData", "runs"]);
    assert.deepEqual(projectDataQueryKeys.tests, ["projectData", "tests"]);

    // Child keys must start with the root key so root invalidation cascades.
    for (const key of [
      projectDataQueryKeys.projects,
      projectDataQueryKeys.runs,
      projectDataQueryKeys.tests,
    ]) {
      assert.equal(
        key[0],
        projectDataQueryKeys.root[0],
        "Child query keys must share the root prefix for hierarchical invalidation",
      );
    }

    // ── Default options ───────────────────────────────────────────────
    const defaults = queryClient.getDefaultOptions();
    assert.equal(
      defaults.queries.refetchOnWindowFocus,
      false,
      "Window-focus refetch should be disabled by default",
    );
    assert.equal(defaults.queries.retry, 1, "Default retry count should be 1");
    assert.equal(defaults.queries.staleTime, 30_000, "Default staleTime should be 30s");
    assert.equal(defaults.queries.gcTime, 30_000, "Default gcTime should be 30s");

    // ── Hierarchical invalidation cascades from root to child keys ────
    // Seed each child key with fresh data, invalidate the root, and verify
    // every child query is marked stale (isInvalidated === true).
    queryClient.setQueryData(projectDataQueryKeys.projects, [{ id: "PRJ-1" }]);
    queryClient.setQueryData(projectDataQueryKeys.runs, [{ id: "RUN-1" }]);
    queryClient.setQueryData(projectDataQueryKeys.tests, [{ id: "TC-1" }]);

    queryClient.invalidateQueries({ queryKey: projectDataQueryKeys.root });

    const cache = queryClient.getQueryCache();
    for (const key of [
      projectDataQueryKeys.projects,
      projectDataQueryKeys.runs,
      projectDataQueryKeys.tests,
    ]) {
      const query = cache.find({ queryKey: key });
      assert.ok(query, `Query for ${JSON.stringify(key)} should exist`);
      assert.equal(
        query.state.isInvalidated,
        true,
        `Root invalidation should cascade to ${JSON.stringify(key)}`,
      );
    }

    queryClient.clear();
    console.log("✅ query-client: all checks passed");
  } catch (err) {
    console.error("❌ query-client failed:", err);
    process.exit(1);
  }
})();
