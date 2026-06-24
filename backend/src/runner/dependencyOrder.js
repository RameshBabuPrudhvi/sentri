/**
 * @module runner/dependencyOrder
 * @description Pure helpers for AUTO-014 test dependency ordering.
 */

function idOf(test) {
  return test?.id ?? test?.testId;
}

function depsOf(test) {
  return Array.isArray(test?.dependsOn) ? test.dependsOn : [];
}

function buildGraph(tests) {
  const ids = new Set(tests.map(idOf).filter(Boolean));
  const depsById = new Map();
  const dependentsById = new Map();
  for (const test of tests) {
    const id = idOf(test);
    if (!id) continue;
    const deps = depsOf(test).filter((depId) => ids.has(depId));
    depsById.set(id, deps);
    for (const depId of deps) {
      if (!dependentsById.has(depId)) dependentsById.set(depId, []);
      dependentsById.get(depId).push(id);
    }
  }
  return { ids, depsById, dependentsById };
}

function cyclePathFromGraph(tests) {
  const { depsById } = buildGraph(tests);
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const depId of depsById.get(id) || []) {
      const found = visit(depId);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const id of depsById.keys()) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

/**
 * Find the first dependency cycle in a test graph.
 * @param {Object[]} tests
 * @returns {string[]|null}
 */
export function findDependencyCycle(tests) {
  if (!Array.isArray(tests)) return null;
  return cyclePathFromGraph(tests);
}

/**
 * Stable topological sort for a dispatched test set.
 * @param {Object[]} tests
 * @param {Object} [options]
 * @param {Iterable<string>} [options.satisfiedTestIds] - Dependencies that
 *   are intentionally outside this sort slice but run earlier (for example,
 *   smoke tests pinned ahead of the non-smoke tail).
 * @returns {{ordered: Object[], skipped: Object[]}}
 */
export function topologicalSortTests(tests, options = {}) {
  if (!Array.isArray(tests) || tests.length === 0) return { ordered: [], skipped: [] };
  const satisfiedIds = new Set(options.satisfiedTestIds || []);

  const cycle = findDependencyCycle(tests);
  if (cycle) {
    const err = new Error("Dependency cycle detected");
    err.code = "CYCLE_DETECTED";
    err.path = cycle;
    throw err;
  }

  const ids = new Set(tests.map(idOf).filter(Boolean));
  const skippedIds = new Set();
  const skipped = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const test of tests) {
      const id = idOf(test);
      if (!id || skippedIds.has(id)) continue;
      const missing = depsOf(test).find((depId) => (!ids.has(depId) && !satisfiedIds.has(depId)) || skippedIds.has(depId));
      if (missing) {
        skippedIds.add(id);
        skipped.push({ ...test, status: "skipped", skipReason: "missing_upstream", missingUpstreamTestId: missing });
        changed = true;
      }
    }
  }

  const active = tests.filter((test) => !skippedIds.has(idOf(test)));
  const originalIndex = new Map(active.map((test, idx) => [idOf(test), idx]));
  const activeIds = new Set(active.map(idOf));
  const inDegree = new Map(active.map((test) => [idOf(test), 0]));
  const dependentsById = new Map();

  for (const test of active) {
    const id = idOf(test);
    for (const depId of depsOf(test)) {
      if (!activeIds.has(depId)) continue;
      inDegree.set(id, (inDegree.get(id) || 0) + 1);
      if (!dependentsById.has(depId)) dependentsById.set(depId, []);
      dependentsById.get(depId).push(id);
    }
  }

  const byId = new Map(active.map((test) => [idOf(test), test]));
  const ready = active
    .filter((test) => inDegree.get(idOf(test)) === 0)
    .map(idOf)
    .sort((a, b) => originalIndex.get(a) - originalIndex.get(b));
  const ordered = [];

  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    const dependents = (dependentsById.get(id) || [])
      .slice()
      .sort((a, b) => originalIndex.get(a) - originalIndex.get(b));
    for (const childId of dependents) {
      inDegree.set(childId, inDegree.get(childId) - 1);
      if (inDegree.get(childId) === 0) {
        ready.push(childId);
        ready.sort((a, b) => originalIndex.get(a) - originalIndex.get(b));
      }
    }
  }

  if (ordered.length !== active.length) {
    const err = new Error("Dependency cycle detected");
    err.code = "CYCLE_DETECTED";
    err.path = findDependencyCycle(active) || [];
    throw err;
  }

  return { ordered, skipped };
}

/**
 * Resolve all tests transitively blocked by failed upstream tests.
 * @param {Object[]} tests
 * @param {Iterable<string>} failedTestIds
 * @returns {Set<string>}
 */
export function computeUpstreamSkips(tests, failedTestIds) {
  const failed = new Set(failedTestIds || []);
  if (!Array.isArray(tests) || failed.size === 0) return new Set();
  const { dependentsById } = buildGraph(tests);
  const skipped = new Set();
  const queue = [...failed];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const childId of dependentsById.get(id) || []) {
      if (failed.has(childId) || skipped.has(childId)) continue;
      skipped.add(childId);
      queue.push(childId);
    }
  }
  return skipped;
}
