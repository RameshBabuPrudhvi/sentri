/**
 * @module pipeline/flowGraph
 * @description Extracts meaningful user flows from an explored state graph.
 *
 * After the state explorer has built a graph of `(state, action) → state`
 * transitions, this module analyses it to produce:
 *   - **Terminal flows** — paths from the start state to a "terminal" state
 *     (success confirmation, error, different page section)
 *   - **Form flows** — sequences that fill fields then submit
 *   - **Navigation flows** — multi-page traversals via link clicks
 *
 * Each extracted flow is a sequence of observed `{ state, action, resultState }`
 * triples that can be fed directly to the journey prompt for test generation.
 *
 * ### Exports
 * - {@link extractFlows} — `(stateGraph) → Flow[]`
 * - {@link flowToJourney} — `(flow, snapshotsByFingerprint) → journey object`
 */

// ── Flow extraction ─────────────────────────────────────────────────────────

/**
 * Find all distinct paths from the start state to states with no outgoing
 * edges (terminal states) or states that loop back to an earlier state.
 *
 * Uses iterative DFS with a depth limit to avoid combinatorial explosion.
 *
 * @param {object} stateGraph — `{ states, edges, startState, snapshotsByFp }`
 * @param {number} [maxDepth=6] — maximum path length
 * @returns {Array<Array<{ fromFp: string, action: object, toFp: string }>>}
 */
function findPaths(stateGraph, maxDepth = 6) {
  const { edges, startState } = stateGraph;
  const paths = [];

  // Build adjacency: fromFp → [{ action, toFp }]
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.fromFp)) adjacency.set(edge.fromFp, []);
    adjacency.get(edge.fromFp).push(edge);
  }

  // Iterative DFS with explicit stack
  // Each stack entry: { fp, path, visited }
  const stack = [{ fp: startState, path: [], visited: new Set([startState]) }];

  while (stack.length > 0) {
    const { fp, path, visited } = stack.pop();

    const neighbors = adjacency.get(fp) || [];

    if (neighbors.length === 0 && path.length > 0) {
      // Terminal state — record this path
      paths.push([...path]);
      continue;
    }

    if (path.length >= maxDepth) {
      // Depth limit — record what we have if it's meaningful
      if (path.length >= 2) paths.push([...path]);
      continue;
    }

    let hasUnvisited = false;
    for (const edge of neighbors) {
      if (visited.has(edge.toFp)) {
        // Loop detected — record the path up to here if meaningful
        if (path.length >= 2) {
          const loopPath = [...path, edge];
          // Only record if we haven't already recorded this exact sequence
          paths.push(loopPath);
        }
        continue;
      }

      hasUnvisited = true;
      const newVisited = new Set(visited);
      newVisited.add(edge.toFp);
      stack.push({
        fp: edge.toFp,
        path: [...path, edge],
        visited: newVisited,
      });
    }

    // Dead end with some path accumulated
    if (!hasUnvisited && path.length >= 2) {
      paths.push([...path]);
    }
  }

  return paths;
}

/**
 * Classify a flow based on the actions it contains.
 *
 * @param {Array} path — array of edge objects
 * @returns {string} flow type: "AUTH" | "FORM_SUBMISSION" | "SEARCH" | "NAVIGATION" | "CRUD"
 */
function classifyFlow(path) {
  const actionTexts = path.map(e => (e.action?.element?.text || "").toLowerCase()).join(" ");
  const actionTypes = path.map(e => e.action?.type || "");
  const hasSubmit = actionTypes.includes("submit");
  const hasFill = actionTypes.includes("fill");

  if (/password|login|sign\s?in|log\s?in/.test(actionTexts)) return "AUTH";
  if (/search|find|filter/.test(actionTexts)) return "SEARCH";
  if (/checkout|buy|purchase|cart|pay/.test(actionTexts)) return "CHECKOUT";
  if (/create|new|add|edit|save|update|delete/.test(actionTexts)) return "CRUD";
  if (hasFill && hasSubmit) return "FORM_SUBMISSION";
  return "NAVIGATION";
}

/**
 * Deduplicate flows that traverse the same sequence of states.
 *
 * @param {Array} paths
 * @returns {Array}
 */
function deduplicateFlows(paths) {
  const seen = new Set();
  return paths.filter(path => {
    const key = path.map(e => `${e.fromFp}->${e.toFp}`).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract meaningful user flows from the state graph.
 *
 * @param {object} stateGraph — `{ states: Set, edges: Array, startState: string, snapshotsByFp: Map }`
 * @returns {Array<{
 *   name: string,
 *   type: string,
 *   path: Array<{ fromFp: string, action: object, toFp: string }>,
 *   description: string,
 *   _discoveredBy: string
 * }>}
 */
export function extractFlows(stateGraph) {
  const rawPaths = findPaths(stateGraph);
  const uniquePaths = deduplicateFlows(rawPaths);

  // Sort by length descending — longer flows are more valuable
  uniquePaths.sort((a, b) => b.length - a.length);

  // Cap at 10 flows to keep LLM calls bounded
  const cappedPaths = uniquePaths.slice(0, 10);

  return cappedPaths.map((path, idx) => {
    const type = classifyFlow(path);
    const actionSummary = path.map(e => {
      const act = e.action;
      if (!act) return "navigate";
      if (act.type === "fill") return `fill "${act.element?.label || act.element?.placeholder || "field"}"`;
      if (act.type === "click" || act.type === "submit") return `click "${(act.element?.text || "element").slice(0, 30)}"`;
      if (act.type === "select") return `select "${act.element?.label || "dropdown"}"`;
      if (act.type === "check") return `check "${act.element?.label || act.element?.text || "checkbox"}"`;
      return act.type;
    }).join(" → ");

    return {
      name: `${type} Flow ${idx + 1}`,
      type,
      path,
      description: `Observed ${path.length}-step flow: ${actionSummary}`,
      _discoveredBy: "state_explorer",
    };
  });
}

/**
 * Convert an extracted flow into a journey object compatible with the existing
 * {@link module:pipeline/journeyGenerator.generateJourneyTest} interface.
 *
 * The existing journey system expects `{ name, type, pages[], description }`.
 * We map each unique state in the flow to a "page" entry, and attach the
 * observed action sequence as `_observedActions` for the enhanced prompt.
 *
 * @param {object} flow — from extractFlows()
 * @param {Map<string, object>} snapshotsByFp — fingerprint → snapshot
 * @returns {object} journey object for journeyGenerator
 */
export function flowToJourney(flow, snapshotsByFp) {
  // Collect unique states in traversal order
  const seenFps = new Set();
  const pages = [];

  for (const edge of flow.path) {
    if (!seenFps.has(edge.fromFp)) {
      seenFps.add(edge.fromFp);
      const snap = snapshotsByFp.get(edge.fromFp);
      if (snap) {
        pages.push({
          url: snap.url,
          title: snap.title || snap.url,
          dominantIntent: flow.type,
          _stateFingerprint: edge.fromFp,
        });
      }
    }
    if (!seenFps.has(edge.toFp)) {
      seenFps.add(edge.toFp);
      const snap = snapshotsByFp.get(edge.toFp);
      if (snap) {
        pages.push({
          url: snap.url,
          title: snap.title || snap.url,
          dominantIntent: flow.type,
          _stateFingerprint: edge.toFp,
        });
      }
    }
  }

  // Build the observed action sequence for the enhanced prompt
  const observedActions = flow.path.map(edge => {
    const snap = snapshotsByFp.get(edge.fromFp);
    const act = edge.action;
    return {
      onPage: snap?.url || "unknown",
      actionType: act?.type || "navigate",
      target: act?.element?.text || act?.element?.label || act?.element?.placeholder || "",
      value: act?.value || null,
      resultPage: snapshotsByFp.get(edge.toFp)?.url || "unknown",
    };
  });

  return {
    name: flow.name,
    type: flow.type,
    pages,
    description: flow.description,
    _discoveredBy: flow._discoveredBy,
    _observedActions: observedActions,
  };
}
