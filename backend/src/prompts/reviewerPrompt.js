/**
 * @module prompts/reviewerPrompt
 * @description Reviewer agent prompt — quality gate (AUTO-023 step 7).
 *
 * The Reviewer is the last LLM pass before tests reach the user. It checks
 * for issues the heuristic validator (`pipeline/testValidator.js`) can't
 * catch: brittle selectors that happen to be syntactically valid,
 * assertions that test the wrong thing, tests that race against the SUT's
 * load state.
 *
 * ### Output contract
 *
 *   { "verdict": "accept" | "revise" | "reject",
 *     "rationale": "<one sentence>",
 *     "issues": [{ "testId": "<id from author artifact>",
 *                  "severity": "high" | "low",
 *                  "category": "<...>",
 *                  "message": "..." }] }
 *
 * - `verdict: "accept"` → test ships to draft as usual. `issues[]` MAY
 *   contain low-severity advisory notes the operator can review later.
 * - `verdict: "revise"` → reviewer asks author for another round.
 * - `verdict: "reject"` → unrecoverable final rejection.
 *
 * ### Failure modes
 *
 * - Invalid JSON → orchestrator falls back to the heuristic validator's
 *   decision (test passes through unchanged).
 * - LLM rate-limited or breaker-tripped → same fallback.
 * - Per-run cost cap exceeded → same fallback for remaining tests.
 *
 * Cost shape mirrors Oracle: ~$0.005/test, $0.15 for a 30-test run, well
 * under the $1.00 default `reviewerMaxCostUsdPerRun` cap from migration 058.
 */

/**
 * Build the Reviewer prompt for a single test.
 *
 * @param {Object} args
 * @param {Object} args.test            - The Oracle- (or heuristic-) enhanced test.
 * @param {Object} [args.classifiedPage] - Page intent + URL for context.
 * @returns {string} Prompt text ready for `generateText(...)`.
 */
export function buildReviewerPrompt({ test, classifiedPage }) {
  return `You are the Reviewer agent — the final quality gate before tests reach the user.

Review this test and decide: accept, revise, or reject?

\`\`\`
Test name: ${test?.name || "unnamed"}
Intent: ${test?.intent || "(no intent recorded)"}
URL: ${classifiedPage?.url || test?.sourceUrl || "(no URL)"}

Code:
${test?.playwrightCode || "(no code)"}
\`\`\`

### Accept when
- Selectors are stable (data-testid, role-based locators, accessible names)
- Wait conditions are present where the test acts on dynamic content
- Assertions verify meaningful outcomes (cart count, form submission success, navigation completion)
- Test name clearly describes what's being tested
- The test, if it passes, gives real evidence the feature works

### Reject when
- Selectors rely on volatile attributes (auto-generated CSS classes like \`.css-1a2b3c\`, deep XPath, text that's likely to change between releases)
- Test uses \`waitForTimeout\` instead of waiting for an element/state (race condition risk)
- Assertions don't actually verify the test's stated intent (false-positive risk — test passes even if the feature is broken)
- Test name is generic (\`"Test 1"\`, \`"Login test"\`) or doesn't match what the code does
- The user action chain doesn't actually exercise the intent (e.g. an "add to cart" test that never clicks the add-to-cart button)

### Output

Respond with valid JSON only — no prose around it.

\`\`\`json
{
  "verdict": "accept" | "revise" | "reject",
  "rationale": "<one sentence>",
  "issues": [
    {
      "testId": "<must match this test id when present>",
      "severity": "high" | "low",
      "category": "brittle_selector" | "race_condition" | "weak_assertion" | "wrong_intent" | "other",
      "message": "<specific actionable description>"
    }
  ]
}
\`\`\`

### Rules
- If \`verdict\` is \`"revise"\`, \`issues\` MUST be non-empty and contain at least one \`severity: "high"\` entry.
- If \`verdict\` is \`"accept"\`, \`issues\` MAY be empty or contain only low-severity advisory notes.
- If \`verdict\` is \`"reject"\`, include a short rationale and any critical issues that made the test unrecoverable.
- Be strict but fair — reject only when a real reviewer would. Stylistic preferences (formatting, naming style) are NEVER grounds for rejection.
- Each issue's \`message\` must be specific enough to act on (e.g. "selector \`.css-1a2b3c\` is auto-generated — use \`getByRole('button', { name: 'Submit' })\`"). Vague messages like "selector is bad" are not useful.
`;
}

/**
 * @typedef {Object} ReviewerIssue
 * @property {string} testId
 * @property {string} problem
 * @property {string} [suggestion]
 */

/**
 * @typedef {Object} ReviewerVerdict
 * @property {"accept"|"revise"|"reject"} verdict
 * @property {ReviewerIssue[]} issues
 * @property {Array<{testId: string, problem: string, reason: "unknown_test_id"|"missing_fields"}>} [droppedIssues]
 *   Issues that didn't survive validation, with the reason. Populated only
 *   when something was actually dropped — empty / undefined on clean input.
 */

/**
 * Error thrown by `normalizeReviewerVerdict` in strict mode when the
 * reviewer's `issues[]` violate the roadmap contract documented at
 * `docs/roadmap/autonomous-multi-agent.md:222-223` ("`issues[].testId`
 * MUST reference a test from the author's most recent `handoff`
 * artifact"). Carries the dropped issues for audit / debugging.
 *
 * Callers (the loop runner, the orchestrator) catch this and decide
 * whether to downgrade to `accept` or surface it as a hard reviewer
 * failure. The class shape mirrors `ReviewRejection` in `agentLoop.js`
 * (Error subclass + typed `.code`) so error-handling sites use one
 * pattern across the bundle.
 */
export class ReviewerEnvelopeError extends Error {
  constructor(message, { droppedIssues = [] } = {}) {
    super(message);
    this.name = "ReviewerEnvelopeError";
    this.code = "ERR_REVIEWER_ENVELOPE_INVALID";
    this.droppedIssues = droppedIssues;
  }
}

/**
 * Parse + normalize reviewer JSON output into the Bundle-3 verdict shape.
 *
 * ### Validation contract
 *
 * Per `docs/roadmap/autonomous-multi-agent.md:222-223` Bundle 3 specifies:
 *
 *   > `issues[].testId` MUST reference a test from the author's most
 *   > recent `handoff` artifact (else envelope validation fails)
 *
 * This function enforces the contract in two modes:
 *
 *   - **Soft (default — `strict: false`):** drop issues that violate
 *     the contract and populate `droppedIssues` on the return value so
 *     callers can audit the filtering. Mirrors the pre-fix silent
 *     behaviour but surfaces the drops instead of hiding them. Used by
 *     UI / prompt-parse code paths where we want best-effort recovery
 *     from a bad LLM response.
 *   - **Strict (opt-in — `strict: true`):** throw
 *     `ReviewerEnvelopeError` when any issue references an unknown
 *     `testId`. Used by the loop runner / orchestrator where envelope-
 *     schema integrity is part of the termination contract — the loop
 *     catches the error and treats it as a structured "reviewer
 *     envelope violation" outcome instead of silently rejecting the
 *     issues. Soft mode is the default so existing callers don't
 *     break; strict mode is the roadmap-spec behaviour.
 *
 * Both modes also downgrade a `revise` verdict with zero surviving
 * issues to `accept` (so the loop never fires another author round
 * with empty feedback) — that's the no-actionable-signal safety net,
 * orthogonal to the testId-validation contract above.
 *
 * @param {unknown} raw
 * @param {Set<string>} validTestIds  Set of testIds from the author's
 *   most recent handoff artifact. Empty Set = "no constraint" (existing
 *   callers without testId tracking pass through unchanged).
 * @param {Object} [opts]
 * @param {boolean} [opts.strict=false]  When true, throw
 *   `ReviewerEnvelopeError` on testId violations instead of dropping.
 * @returns {ReviewerVerdict}
 * @throws {ReviewerEnvelopeError} (strict mode only) when any
 *   `issues[].testId` is not in `validTestIds`.
 */
export function normalizeReviewerVerdict(raw, validTestIds = new Set(), opts = {}) {
  const { strict = false } = opts;
  const verdictRaw = String(raw?.verdict || raw?.intent || "accept").toLowerCase();
  const verdict = verdictRaw === "revise" || verdictRaw === "reject" ? verdictRaw : "accept";
  const issuesIn = Array.isArray(raw?.issues) ? raw.issues : [];

  // Stage 1: shape the issues + drop ones with missing required fields.
  // Captured drops carry a `reason` so the caller can distinguish "LLM
  // returned garbage" from "LLM picked the wrong testId".
  const droppedIssues = [];
  const shaped = issuesIn.map((i) => ({
    testId: String(i?.testId || "").trim(),
    problem: String(i?.problem || i?.message || "").trim(),
    suggestion: i?.suggestion ? String(i.suggestion).trim() : undefined,
  }));
  const withFields = [];
  for (const issue of shaped) {
    if (!issue.testId || !issue.problem) {
      droppedIssues.push({ testId: issue.testId, problem: issue.problem, reason: "missing_fields" });
    } else {
      withFields.push(issue);
    }
  }

  // Stage 2: enforce the roadmap's "testId MUST reference a test from
  // the author's most recent handoff artifact" contract.
  const issues = [];
  for (const issue of withFields) {
    if (validTestIds.size === 0 || validTestIds.has(issue.testId)) {
      issues.push(issue);
    } else {
      droppedIssues.push({ testId: issue.testId, problem: issue.problem, reason: "unknown_test_id" });
    }
  }

  // Strict mode: any unknown_test_id drop is a contract violation —
  // throw so the caller can treat it as a structured outcome rather
  // than silently filtering. The throw fires AFTER we've shaped the
  // full droppedIssues list so the error carries every violation for
  // audit, not just the first one.
  if (strict) {
    const unknownTestIdDrops = droppedIssues.filter((d) => d.reason === "unknown_test_id");
    if (unknownTestIdDrops.length > 0) {
      throw new ReviewerEnvelopeError(
        `reviewer envelope references unknown testIds: ${unknownTestIdDrops.map((d) => d.testId).join(", ")}`,
        { droppedIssues: unknownTestIdDrops },
      );
    }
  }

  // Empty-issues downgrade — orthogonal to the contract above. If the
  // reviewer asked for a revision but no surviving issue carries
  // actionable feedback, fall back to accept rather than burn the next
  // author round on `reviewerIssues: []`.
  if (verdict === "revise" && issues.length === 0) {
    return droppedIssues.length > 0
      ? { verdict: "accept", issues: [], droppedIssues }
      : { verdict: "accept", issues: [] };
  }
  return droppedIssues.length > 0
    ? { verdict, issues, droppedIssues }
    : { verdict, issues };
}
