-- AUTO-002: surface the diff-aware crawl's per-run page-change summary
-- (changedPages[] + removedPages[]) on the run response so reviewers can
-- see at a glance which URLs triggered regeneration. Stored as JSON text.
ALTER TABLE runs ADD COLUMN changedPages TEXT;
ALTER TABLE runs ADD COLUMN removedPages TEXT;
