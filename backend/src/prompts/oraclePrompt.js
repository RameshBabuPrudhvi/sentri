/**
 * @module prompts/oraclePrompt
 * @description Oracle agent prompt — assertion strengthening (AUTO-023 step 6).
 *
 * Reads an Author-generated test and proposes stronger, more meaningful
 * assertions. Receives the test's existing Playwright code + the page
 * snapshot it targets; returns either the original code (no change needed)
 * or a fully-rewritten version with upgraded assertions.
 *
 * ### Output contract
 *
 *   { "decision": "keep" | "rewrite",
 *     "rationale": "<one sentence>",
 *     "playwrightCode": "<full updated code — ONLY when decision is rewrite>",
 *     "upgradedAssertions": [{ "kind": "<assertion-type>", "reason": "<why>" }] }
 *
 * - `decision: "keep"` short-circuits the rewrite — the orchestrator does
 *   NOT overwrite the test, and `playwrightCode` MAY be omitted.
 * - `decision: "rewrite"` requires `playwrightCode` to be a complete
 *   replacement (not a diff). Invalid JSON or missing fields → orchestrator
 *   falls back to the heuristic-enhanced version (augment-not-replace).
 *
 * ### Cost
 *
 * Per-test call: ~500 input tokens (prompt + code + DOM snapshot summary) +
 * ~300 output tokens on average. At Claude Sonnet pricing (~$3/M input,
 * ~$15/M output) → ~$0.006 / test. A 30-test run lands around $0.18 plus
 * provider overhead, well under the $1.00 default `oracleMaxCostUsdPerRun`
 * cap from migration 058.
 *
 * ### Failure modes
 *
 * - Invalid JSON in the response → orchestrator returns the heuristic-
 *   enhanced test unchanged.
 * - `decision: "rewrite"` without `playwrightCode` → same fallback.
 * - LLM call throws (rate-limit, breaker tripped, network error) → same.
 * - Per-run cost ceiling exceeded → remaining tests skip the LLM call
 *   and use heuristic-only.
 */

/**
 * Build the Oracle prompt for a single test.
 *
 * @param {Object} args
 * @param {Object} args.test            - The heuristic-enhanced test (carries `name`, `intent`, `playwrightCode`).
 * @param {Object} [args.classifiedPage] - The page's classified intent + URL (from intentClassifier).
 * @param {Object} [args.snapshot]      - Page DOM snapshot (used for context only — trimmed before prompt assembly).
 * @returns {string} Prompt text ready for `generateText(...)`.
 */
export function buildOraclePrompt({ test, classifiedPage, snapshot }) {
  // Trim DOM snapshot to ~2 KB to bound prompt size. The LLM doesn't need
  // every element to reason about assertions; the high-signal subset
  // (interactive elements, headings, key text) is enough and stays well
  // under the per-test token budget that drives the cost estimate above.
  const trimmedSnapshot = trimDomSnapshot(snapshot, 2048);

  return `You are the Oracle agent — your job is to make Playwright test assertions stronger and more meaningful.

A weak assertion just checks that a page loaded. A strong assertion verifies that the action ACTUALLY succeeded — cart count incremented, form error shown, confirmation message rendered, response code returned.

You are reviewing this test:

\`\`\`
Test name: ${test?.name || "unnamed"}
Intent: ${test?.intent || "(no intent recorded)"}
URL: ${classifiedPage?.url || test?.sourceUrl || "(no URL)"}

Current code:
${test?.playwrightCode || "(no code)"}
\`\`\`

Target page DOM (trimmed for context):
${trimmedSnapshot}

Your task: decide whether the test's assertions are already meaningful, or whether they should be strengthened.

### Strong assertions check
- Specific user-visible outcomes (cart count, success messages, navigation completion)
- Form validation states (specific error messages, not just "an error appeared")
- Network response codes or response body shapes (for tests that do API verification)
- Element COUNT changes (cart went from 0 to 1, not just "cart is visible")

### Weak assertions to avoid
- Just \`expect(page).toHaveURL(...)\` without verifying content
- \`expect(element).toBeVisible()\` on elements that were already visible before the user action
- Generic existence checks on parent containers (\`body\`, \`main\`) that always pass

### Output

Respond with valid JSON only — no prose around it.

\`\`\`json
{
  "decision": "keep" | "rewrite",
  "rationale": "<one sentence explaining the decision>",
  "playwrightCode": "<full updated test code — ONLY when decision is rewrite>",
  "upgradedAssertions": [
    { "kind": "<e.g. cart_count_change>", "reason": "<why this is stronger>" }
  ]
}
\`\`\`

### Rules
- If the existing assertions are already strong, return \`decision: "keep"\` and omit \`playwrightCode\`.
- If you rewrite, the new code MUST be complete Playwright code that runs as-is (not a diff, not partial).
- Preserve the test's existing structure — only modify the assertions, not the user actions or selectors.
- Never weaken existing assertions. If you can't strengthen them, keep.
- \`upgradedAssertions[]\` is informational — list each new/strengthened check so the operator can see what changed.
`;
}

/**
 * Trim a DOM snapshot to roughly `maxBytes` characters, preferring high-
 * signal interactive elements over decorative content.
 *
 * Strategy:
 *   1. If `snapshot.elements` is an array (the canonical shape produced
 *      by `pipeline/elementFilter.js`), serialise a compact summary of
 *      each — selector + tag + accessible text — and truncate at the
 *      element boundary closest to `maxBytes`.
 *   2. If `snapshot.html` is a string (legacy / raw capture), slice
 *      directly to `maxBytes` characters. Lossy but bounded.
 *   3. Anything else → return a "no snapshot" placeholder so the prompt
 *      still parses; the LLM degrades to keyword-only reasoning.
 *
 * The 2 KB default is a soft target — element boundaries may push the
 * actual length slightly under or over. Never returns more than
 * `maxBytes * 1.1` characters as a hard ceiling.
 */
function trimDomSnapshot(snapshot, maxBytes = 2048) {
  if (!snapshot || typeof snapshot !== "object") return "(no snapshot available)";
  const hardCeiling = Math.floor(maxBytes * 1.1);

  // 1. Preferred path: element array from `pipeline/elementFilter.js`.
  if (Array.isArray(snapshot.elements) && snapshot.elements.length > 0) {
    const lines = [];
    let bytes = 0;
    for (const el of snapshot.elements) {
      if (!el || typeof el !== "object") continue;
      const selector = el.selector || el.css || el.xpath || "?";
      const tag = el.tag || el.role || "?";
      const label = (el.text || el.accessibleName || el.placeholder || "").slice(0, 80);
      const line = `- ${tag} [${selector}] ${label}`.trim();
      if (bytes + line.length + 1 > hardCeiling) break;
      lines.push(line);
      bytes += line.length + 1; // +1 for newline
      if (bytes >= maxBytes) break;
    }
    return lines.length > 0 ? lines.join("\n") : "(no interactive elements)";
  }

  // 2. Fallback: raw HTML truncated to maxBytes.
  if (typeof snapshot.html === "string" && snapshot.html.length > 0) {
    return snapshot.html.slice(0, maxBytes);
  }

  return "(no snapshot available)";
}
