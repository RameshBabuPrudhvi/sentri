-- Migration 057: per-agent SSE events (Task 2 — backend agent events)
--
-- Persists every `agent_event` SSE payload so a reconnecting client gets the
-- full per-agent narrative replay on the snapshot, not just whatever arrived
-- after the EventSource opened. Mirrors the `run_logs` table (ENH-008) pattern
-- — append-only, indexed by (runId, createdAt) for ordered hydration.
--
-- ### Phase values
--
--   start      — agent began work on this step.
--   progress   — incremental update (intermediate finding, token tick).
--   finding    — concrete artifact discovered (URL, journey, test name).
--   handoff    — agent A finished; agent B is taking over (nextAgent set).
--   done       — agent finished this step.
--
-- Phase is CHECK-constrained so a typo at the emitter fails fast instead of
-- polluting the feed with un-queryable variants — same defence the SEC-007
-- audit-log action allow-list uses.

CREATE TABLE IF NOT EXISTS run_agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runId TEXT NOT NULL,
  step INTEGER NOT NULL,
  agent TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('start','progress','finding','handoff','done')),
  message TEXT,
  data TEXT,
  nextAgent TEXT,
  model TEXT,
  createdAt TEXT NOT NULL
);

-- Composite covering index for the canonical hydration query
-- (`WHERE runId = ? ORDER BY createdAt ASC`) used by both
-- `runAgentEventRepo.getByRunId` and the `runRepo.getById` hydration path.
CREATE INDEX IF NOT EXISTS idx_run_agent_events_runId ON run_agent_events(runId, createdAt);
