-- AUTO-004: Persist git-diff impact-analysis inputs and resolved scope.
-- changedFiles is the normalized git diff file list from the trigger payload
-- or GitHub PR Files API. impactAnalysis stores the pure helper's summary
-- ({ impactedTestIds, fallbackReason, routePrefixes }) for Run Detail.
ALTER TABLE runs ADD COLUMN changedFiles TEXT;
ALTER TABLE runs ADD COLUMN impactAnalysis TEXT;
