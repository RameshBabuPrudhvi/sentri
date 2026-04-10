/**
 * @module utils/splitCodeBySteps
 * @description Split Playwright code into per-step chunks for the source view.
 *
 * Strategies (tried in order):
 *   1. **Comment markers** — `// Step 1:`, `// Step 2:`, etc. in the code
 *   2. **Keyword matching** — match step descriptions against code lines
 *   3. **Even distribution** — fallback: split lines evenly across steps
 */

/**
 * Extract the test body from a Playwright test function.
 * @param {string} code
 * @returns {string}
 */
function extractBody(code) {
  const arrowMatch = code.match(/async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{([\s\S]*)/);
  if (!arrowMatch) return code;
  const bodyAndRest = arrowMatch[1];
  let depth = 1, i = 0;
  for (; i < bodyAndRest.length && depth > 0; i++) {
    if (bodyAndRest[i] === "{") depth++;
    else if (bodyAndRest[i] === "}") depth--;
  }
  return bodyAndRest.slice(0, i - 1).trim();
}

/**
 * Try to split code using `// Step N:` comment markers.
 * Returns null if fewer than half the steps have markers.
 */
function trySplitByMarkers(lines, stepCount) {
  // Match patterns like: // Step 1, // Step 1:, // step 1 -, // 1., // 1:
  const markerRe = /^\s*\/\/\s*(?:step\s+)?(\d+)\s*[:.:\-—]/i;
  const markerIndices = new Map(); // stepNum → lineIndex

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(markerRe);
    if (m) {
      const stepNum = parseInt(m[1], 10);
      if (stepNum >= 1 && stepNum <= stepCount && !markerIndices.has(stepNum)) {
        markerIndices.set(stepNum, i);
      }
    }
  }

  // Require markers for at least half the steps
  if (markerIndices.size < Math.ceil(stepCount / 2)) return null;

  const chunks = [];
  for (let s = 1; s <= stepCount; s++) {
    const start = markerIndices.get(s);
    if (start == null) {
      chunks.push("");
      continue;
    }
    // Find the next marker or end of lines
    let end = lines.length;
    for (let next = s + 1; next <= stepCount; next++) {
      if (markerIndices.has(next)) {
        end = markerIndices.get(next);
        break;
      }
    }
    chunks.push(lines.slice(start, end).join("\n"));
  }
  return chunks;
}

/**
 * Try to split code by matching step description keywords against code lines.
 * Returns null if too few steps could be matched.
 */
function trySplitByKeywords(lines, stepCount, steps) {
  if (!steps || steps.length !== stepCount) return null;

  // For each step, find the best-matching line index
  const assignments = new Array(stepCount).fill(-1);
  const usedLines = new Set();

  for (let s = 0; s < stepCount; s++) {
    const stepWords = (steps[s] || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(" ")
      .filter(w => w.length > 3);
    if (stepWords.length === 0) continue;

    let bestLine = -1;
    let bestScore = 0;

    for (let i = 0; i < lines.length; i++) {
      if (usedLines.has(i)) continue;
      const lineLower = lines[i].toLowerCase();
      const score = stepWords.filter(w => lineLower.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        bestLine = i;
      }
    }

    // Require at least 2 matching words to avoid false positives from common
    // Playwright keywords (e.g. "page", "click") that appear on many lines.
    // For steps with only 1 keyword (after filtering ≤3-char words), skip
    // keyword matching and let the even-distribution fallback handle it.
    if (bestScore >= 2 && bestLine >= 0) {
      assignments[s] = bestLine;
      usedLines.add(bestLine);
    }
  }

  // Require at least 1/3 of steps matched
  const matchedCount = assignments.filter(a => a >= 0).length;
  if (matchedCount < Math.ceil(stepCount / 3)) return null;

  // Sort matched steps by their line position to ensure order
  // Fill gaps: unmatched steps get lines between their neighbors
  const sortedAssignments = [...assignments];

  // Forward-fill: ensure assignments are monotonically increasing
  let lastAssigned = -1;
  for (let s = 0; s < stepCount; s++) {
    if (sortedAssignments[s] >= 0) {
      if (sortedAssignments[s] <= lastAssigned) {
        sortedAssignments[s] = -1; // out of order, skip
      } else {
        lastAssigned = sortedAssignments[s];
      }
    }
  }

  // Build chunks from sorted assignments
  const chunks = [];
  for (let s = 0; s < stepCount; s++) {
    const start = sortedAssignments[s];
    if (start < 0) {
      chunks.push("");
      continue;
    }
    // Find end: next assigned step's start, or end of lines
    let end = lines.length;
    for (let next = s + 1; next < stepCount; next++) {
      if (sortedAssignments[next] >= 0) {
        end = sortedAssignments[next];
        break;
      }
    }
    chunks.push(lines.slice(start, end).join("\n"));
  }
  return chunks;
}

/**
 * Split Playwright code into per-step chunks for the source view.
 *
 * Tries three strategies in order:
 *   1. Comment markers (`// Step N:`)
 *   2. Keyword matching (step descriptions vs code lines)
 *   3. Even line distribution (fallback)
 *
 * @param {string|null} code - Full Playwright test source code.
 * @param {number} stepCount - Number of test steps.
 * @param {string[]} [steps] - Step description strings (for keyword matching).
 * @returns {string[]} Array of code chunks, one per step.
 */
export default function splitCodeBySteps(code, stepCount, steps) {
  if (!code || stepCount === 0) return [];

  const body = extractBody(code);
  const lines = body.split("\n").map(l => l.trimEnd()).filter(l => l.trim());
  if (lines.length === 0) return Array(stepCount).fill("");

  // Strategy 1: Comment markers
  const byMarkers = trySplitByMarkers(lines, stepCount);
  if (byMarkers) return byMarkers;

  // Strategy 2: Keyword matching (only if step descriptions are provided)
  if (steps && steps.length === stepCount) {
    const byKeywords = trySplitByKeywords(lines, stepCount, steps);
    if (byKeywords) return byKeywords;
  }

  // Strategy 3: Even distribution (fallback)
  const baseSize = Math.max(1, Math.floor(lines.length / stepCount));
  const remainder = lines.length % stepCount;
  const chunks = [];
  let cursor = 0;
  for (let s = 0; s < stepCount; s++) {
    if (cursor >= lines.length) {
      // No more lines — show "No code for this step." in the UI
      chunks.push("");
      continue;
    }
    const isLast = s === stepCount - 1;
    const take = isLast ? lines.length - cursor : baseSize;
    chunks.push(lines.slice(cursor, cursor + Math.max(take, 1)).join("\n"));
    cursor += Math.max(take, 1);
  }
  return chunks;
}