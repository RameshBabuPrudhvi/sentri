/**
 * @module utils/dependencyGraph
 * @description Frontend parity helpers for test dependency validation.
 */

function idOf(test) {
  return test?.id ?? test?.testId;
}

function depsOf(test) {
  return Array.isArray(test?.dependsOn) ? test.dependsOn : [];
}

/**
 * Find the first cycle in a test dependency graph.
 * @param {Object[]} tests
 * @returns {string[]|null}
 */
export function findDependencyCycle(tests) {
  if (!Array.isArray(tests)) return null;
  const ids = new Set(tests.map(idOf).filter(Boolean));
  const depsById = new Map();
  for (const test of tests) {
    const id = idOf(test);
    if (!id) continue;
    depsById.set(id, depsOf(test).filter((depId) => ids.has(depId)));
  }
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
