-- B6.2 — Semantic LLM review pass (AUDIT-ROADMAP Bundle 6, QAL-005).
--
-- Adds two columns to `tests` that capture the verdict of the optional
-- second-pass LLM reviewer. Distinct from the heuristic `validateTest`
-- (locator quality / matcher allowlist / secret scan) and from the B3
-- reviewer↔author loop — semantic review asks four FOUR contract
-- questions per the spec at `docs/roadmap/AUDIT-ROADMAP.md:752-758`:
--
--   1. Does this test verify a meaningful state change?
--   2. Are any assertions trivially always-true?
--   3. Does the test cover the full described scenario?
--   4. Would this test catch a regression if the feature stopped working?
--
-- Columns:
--   • semanticReviewScore  — INTEGER 0–100. NULL when the project has
--                             `semanticReview = 0` (default) or when the
--                             upstream reviewer-collapse gate (B3) fired,
--                             in which case the semantic pass is silently
--                             skipped per `AUDIT-ROADMAP.md:852-853`.
--   • semanticReviewIssues — TEXT JSON array of string issue
--                             descriptions, capped at 5 entries to keep
--                             the column bounded (the prompt enforces
--                             the cap, the column documents it).
--
-- Industry parallels: GitHub Copilot Workspace's "review your plan"
-- step, Cursor's "explain change" pass, CodeRabbit's structured-review
-- pass — all use a second-LLM pass to catch "looks fine but does
-- nothing" cases that structural validation can't see.
--
-- Cost gate: the semantic call dispatches via `agentRole: 'reviewer'`
-- so the existing per-workspace `agent_configs.maxReviewRounds` /
-- spend-cap / quota infrastructure applies unchanged. The pass fires
-- AT MOST once per generated test, so the worst-case marginal cost is
-- one extra reviewer-tier LLM call per test on opt-in projects.

ALTER TABLE tests ADD COLUMN semanticReviewScore INTEGER;
ALTER TABLE tests ADD COLUMN semanticReviewIssues TEXT;

CREATE INDEX IF NOT EXISTS idx_tests_semanticReviewScore ON tests(semanticReviewScore);
