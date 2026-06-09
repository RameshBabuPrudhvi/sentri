/**
 * @module pipeline/prompts/semanticReviewPrompt
 * @description Second-pass LLM reviewer prompt (AUDIT-ROADMAP Bundle 6, QAL-005).
 *
 * Asks the reviewer four contract questions about a generated test:
 *
 *   1. Does this test verify a meaningful state change?
 *   2. Are any assertions trivially always-true?
 *   3. Does the test cover the full described scenario?
 *   4. Would this test catch a regression if the feature stopped
 *      working?
 *
 * Returns a structured JSON verdict that `feedbackLoop.js` /
 * `testPersistence.js` consume to decide whether the test enters the
 * review queue with a clean status, an issue chip, or a hard reject.
 *
 * Spec: `docs/roadmap/AUDIT-ROADMAP.md:749-765`.
 */

import { buildSystemPrompt } from "./outputSchema.js";

/**
 * Hard cap on persisted `semanticReviewIssues` (column documented in
 * migration 074). The prompt enforces the cap; the consumer truncates
 * defensively if the LLM ignores instructions. Bounded so the persisted
 * JSON column stays small + the Review Queue chip stays readable.
 */
export const SEMANTIC_REVIEW_MAX_ISSUES = 5;

/**
 * Build the prompt envelope for one test. The reviewer always sees the
 * full `playwrightCode` + the scenario description because the
 * always-true-assertion check is a textual pattern match — the LLM has
 * to read the literal expect() calls to evaluate them.
 *
 * @param {Object} test — A persisted (or about-to-persist) test row.
 * @param {Object} [opts]
 * @param {string} [opts.scenario] — Extra free-text describing what the
 *   test is supposed to prove. Defaults to `test.description`.
 * @returns {{ system: string, user: string }}
 */
export function buildSemanticReviewPrompt(test, opts = {}) {
  const scenario = (opts.scenario || test?.description || test?.name || "").trim();
  const url = test?.sourceUrl || "";
  const code = test?.playwrightCode || "";

  // Sanity-bound the code that ships to the LLM — extreme outliers
  // (a single test pushing past 32 KB) would consume the entire
  // context window on local models and produce silent truncation,
  // which is exactly the failure mode B7-2 / QAL-007 will address.
  // Until B7 lands, keep the bound here so semantic review can never
  // be the cause of an overflow.
  const SAFE_CODE_MAX_CHARS = 32_000;
  const trimmed = code.length > SAFE_CODE_MAX_CHARS
    ? code.slice(0, SAFE_CODE_MAX_CHARS) + "\n// …[truncated for semantic review]"
    : code;

  const user = `You are reviewing a generated Playwright test for SEMANTIC quality, NOT for
syntax or selector quality (a separate heuristic validator handles those).

SCENARIO THIS TEST CLAIMS TO VERIFY:
${scenario || "(no scenario description provided)"}

URL UNDER TEST: ${url || "(no source URL)"}

TEST CODE:
\`\`\`javascript
${trimmed}
\`\`\`

Answer four questions about THIS specific test (NOT generic Playwright advice):

1. Does this test verify a MEANINGFUL state change in the application?
   (A test that visits a URL and asserts the page is non-empty is NOT a
   meaningful state change — it's a smoke probe.)

2. Are any assertions TRIVIALLY ALWAYS-TRUE?
   Examples: \`toHaveURL(/http/)\` matches every HTTPS site;
   \`toBeVisible()\` on \`page.locator('body')\` is always true on a loaded page;
   \`toContainText('')\` is always true. Flag each.

3. Does the test cover the FULL described scenario, or only the first step?
   A scenario "user creates an account and sees the dashboard" requires
   BOTH the creation step AND the post-creation dashboard assertion.

4. Would this test catch a REGRESSION if the feature stopped working?
   A test that only checks the form RENDERS would still pass if the
   submit handler was removed — that's not a regression-catching test.

Return ONLY valid JSON (no markdown, no commentary) matching this exact shape:

{
  "score": <integer 0–100>,
  "verdict": "accept" | "revise" | "reject",
  "issues": [<at most ${SEMANTIC_REVIEW_MAX_ISSUES} short strings, each ≤200 chars>]
}

Score guidance:
- 80–100 → "accept" — meaningful, regression-catching, non-trivial.
- 50–79  → "revise" — fixable issues; list them in \`issues\`.
- 0–49   → "reject" — fundamental gap; the test cannot be salvaged
                       without rewriting the scenario.`;

  return { system: buildSystemPrompt(), user };
}

/**
 * Normalise + validate a parsed LLM response into the canonical shape
 * persisted on `tests.semanticReviewScore` / `tests.semanticReviewIssues`.
 * Defensive against missing keys, off-range scores, and verdict typos.
 *
 * @param {unknown} parsed — `parseJSON(text)` output. May be anything.
 * @returns {{ score: number, verdict: "accept"|"revise"|"reject", issues: string[] }}
 */
export function normalizeSemanticReviewResponse(parsed) {
  const raw = parsed && typeof parsed === "object" ? parsed : {};
  // Score: coerce, clamp to [0, 100], default 50 (revise) when missing
  // so the reviewer never silently auto-accepts on a malformed response.
  const rawScore = Number(raw.score);
  const score = Number.isFinite(rawScore)
    ? Math.max(0, Math.min(100, Math.round(rawScore)))
    : 50;
  // Verdict: derive from score when missing / unknown so the consumer
  // path is total (never throws on a misshaped LLM output).
  const allowed = new Set(["accept", "revise", "reject"]);
  const verdict = allowed.has(raw.verdict)
    ? raw.verdict
    : (score >= 80 ? "accept" : score >= 50 ? "revise" : "reject");
  const issues = Array.isArray(raw.issues)
    ? raw.issues
        .map((i) => (typeof i === "string" ? i.slice(0, 200) : ""))
        .filter((s) => s.length > 0)
        .slice(0, SEMANTIC_REVIEW_MAX_ISSUES)
    : [];
  return { score, verdict, issues };
}
