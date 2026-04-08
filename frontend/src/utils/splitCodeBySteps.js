/**
 * @module utils/splitCodeBySteps
 * @description Split Playwright code into per-step chunks for the source view.
 */

/**
 * Distribute the lines of a Playwright test body evenly across `stepCount`
 * buckets. Remainder lines go into the LAST bucket so no trailing step is
 * ever left empty when lines < stepCount * baseSize.
 *
 * @param {string|null} code - Full Playwright test source code.
 * @param {number} stepCount - Number of test steps.
 * @returns {string[]} Array of code chunks, one per step.
 */
export default function splitCodeBySteps(code, stepCount) {
  if (!code || stepCount === 0) return [];

  // 1. Extract the test body from the async arrow function
  const arrowMatch = code.match(/async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{([\s\S]*)/);
  let body = code;
  if (arrowMatch) {
    const bodyAndRest = arrowMatch[1];
    let depth = 1, i = 0;
    for (; i < bodyAndRest.length && depth > 0; i++) {
      if (bodyAndRest[i] === "{") depth++;
      else if (bodyAndRest[i] === "}") depth--;
    }
    body = bodyAndRest.slice(0, i - 1).trim();
  }

  // 2. Split into non-empty lines
  const lines = body.split("\n").map(l => l.trimEnd()).filter(l => l.trim());
  if (lines.length === 0) return Array(stepCount).fill("");

  // 3. Distribute lines evenly; remainder goes into LAST bucket
  const baseSize = Math.floor(lines.length / stepCount);
  const remainder = lines.length % stepCount;

  const chunks = [];
  let cursor = 0;
  for (let s = 0; s < stepCount; s++) {
    const take = baseSize + (s === stepCount - 1 ? remainder : 0);
    const slice = lines.slice(cursor, cursor + Math.max(take, 1));
    chunks.push(slice.join("\n"));
    cursor += Math.max(take, 1);
    if (cursor >= lines.length) {
      while (chunks.length < stepCount) chunks.push("");
      break;
    }
  }
  return chunks;
}
