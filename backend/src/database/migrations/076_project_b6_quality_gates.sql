-- B6 — Per-project quality-gate toggles (AUDIT-ROADMAP Bundle 6).
--
-- Three project-level toggles + one locale knob that gate the four B6
-- sub-features. All default safe-off so the post-migration pipeline is
-- byte-identical to pre-B6 (acceptance criterion at
-- `docs/roadmap/AUDIT-ROADMAP.md:858-859`).
--
-- Columns:
--   • dryRunGate       INTEGER NOT NULL DEFAULT 0 — when 1, every
--                       generated test is executed once via
--                       `pipeline/dryRunGate.js` before entering the
--                       review queue (QAL-001).
--   • semanticReview   INTEGER NOT NULL DEFAULT 0 — when 1 AND the
--                       upstream B3 reviewer-collapse gate has NOT
--                       fired, generated tests get a second-pass
--                       semantic LLM review (QAL-005).
--   • testDataLocale   TEXT NOT NULL DEFAULT 'en' — passed to the
--                       `@faker-js/faker` locale registry by
--                       `utils/fakeDataGenerator.js` so generated test
--                       data matches the target market (QAL-010).
--                       Validated to the published faker locale list at
--                       the route layer; unknown values fall back to
--                       'en' at the consumer.
--
-- Industry convention: opt-in quality gates that default off so the
-- existing customer-base sees zero behaviour change on upgrade. Matches
-- the GitHub Actions `permissions: read-all`, Vercel `Speed Insights`,
-- and Datadog `serverless-monitoring` defaults — every new gate is
-- additive, no breaking change on migration apply.

ALTER TABLE projects ADD COLUMN dryRunGate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN semanticReview INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN testDataLocale TEXT NOT NULL DEFAULT 'en';
