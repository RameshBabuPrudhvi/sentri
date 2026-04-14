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
    let loopCount = 0;
    for (const edge of neighbors) {
      if (visited.has(edge.toFp)) {
        // Loop detected — record the path including the back-edge.
        // Each back-edge may target a different state (e.g. form→error
        // vs form→start), so we record all of them — deduplicateFlows()
        // will collapse any that traverse the same state sequence.
        if (path.length >= 2) {
          paths.push([...path, edge]);
          loopCount++;
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

    // Dead end — only record the base path if NO loop paths were recorded.
    // When loops exist, they already contain this path as a prefix, so
    // recording it again just creates a near-duplicate that wastes LLM tokens.
    if (!hasUnvisited && loopCount === 0 && path.length >= 2) {
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

  // ── Diversity cap: max 2 flows per type ─────────────────────────────────
  // Without this, a site with a prominent sign-in button generates 10 nearly
  // identical AUTH flows because most paths cross the sign-in page. Capping
  // per type ensures the LLM sees a mix of AUTH, SEARCH, NAVIGATION, etc.
  const MAX_PER_TYPE = 2;
  const MAX_TOTAL = 10;
  const typeCounts = {};
  const diversePaths = [];
  for (const path of uniquePaths) {
    if (diversePaths.length >= MAX_TOTAL) break;
    const type = classifyFlow(path);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    if (typeCounts[type] <= MAX_PER_TYPE) {
      diversePaths.push(path);
    }
  }
  // If we have room left after the diversity cap, backfill with remaining paths
  if (diversePaths.length < MAX_TOTAL) {
    for (const path of uniquePaths) {
      if (diversePaths.length >= MAX_TOTAL) break;
      if (!diversePaths.includes(path)) diversePaths.push(path);
    }
  }
  const cappedPaths = diversePaths;

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

  // Build the observed action sequence for the enhanced prompt.
  // Include ARIA role, data-testid, aria-label, and the best selector so the
  // AI can generate targeted Playwright code instead of guessing from text
  // labels alone (which fail when the label is ambiguous or non-unique).
  const observedActions = flow.path.map(edge => {
    const snap = snapshotsByFp.get(edge.fromFp);
    const act = edge.action;
    const el = act?.element;
    return {
      onPage: snap?.url || "unknown",
      actionType: act?.type || "navigate",
      target: el?.text || el?.label || el?.placeholder || "",
      value: act?.value || null,
      resultPage: snapshotsByFp.get(edge.toFp)?.url || "unknown",
      // Selector hints — give the AI concrete locator info so it doesn't
      // have to guess from ambiguous text labels.
      role: el?.role || "",
      testId: el?.testId || "",
      ariaLabel: el?.ariaLabel || "",
      selector: (act?.selectors && act.selectors[0]) || "",
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
