-- Migration 069: B2 — iframe enumeration + SPA hydration + adaptive element timeout
-- (AUDIT-ROADMAP Bundle 2).
--
-- Three loosely-coupled pieces that ship in one migration because they share
-- a single PR scope (per `docs/roadmap/AUDIT-ROADMAP.md:292-441`) and a single
-- frontend settings panel.
--
-- 1. iframe enumeration (`iframeStrategy`, `iframeAllowlist`)
--    --------------------------------------------------------
--    `crawlBrowser.js` / `stateExplorer.js` previously never iterated
--    `page.frames()`, so enterprise apps embedding Stripe Checkout, Intercom,
--    Typeform, payment widgets etc. were invisible to the crawler. With B2
--    we walk frames per page; `iframeStrategy` controls which frames are
--    enumerated:
--      'same-origin' (default) — frames whose effective origin matches
--          the parent page. Cross-origin DOM access throws `SecurityError`
--          by browser policy, so 'same-origin' degrades gracefully.
--      'allowlist'             — frames whose URL prefix matches one of
--          the entries in `iframeAllowlist` (JSON string array).
--      'all'                   — every accessible frame (best-effort;
--          cross-origin frames still throw and are silently skipped).
--      'none'                  — disable iframe enumeration entirely.
--
-- 2. SPA hydration (`hydrationType`, `hydrationSelector`)
--    ----------------------------------------------------
--    React/Vue/Angular/Next.js apps populate the interactive DOM 200–2 000 ms
--    after `domcontentloaded` fires. Snapshots taken at DCL captured skeleton
--    state; generated tests then targeted elements that don't exist at
--    execution time. `hydrationType`:
--      'auto' (default) — framework-aware: wait for the common
--          loading-indicator selectors to disappear AND any detected
--          framework's hydration completion signal.
--      'domcontentloaded' — opt out (legacy behaviour).
--      'custom'           — wait for `hydrationSelector` to disappear.
--
-- 3. Adaptive element timeout (`elementTimeoutOverride`, `runs.p95LoadMs`)
--    -------------------------------------------------------------------
--    The runtime `HEALING_ELEMENT_TIMEOUT` constant (default 5 000 ms) was a
--    hard global. Enterprise apps with 8–15 s API calls produced TIMEOUT
--    failures on every action; the 7-stage healing waterfall then burned
--    35 s before falling through. With B2 the runner computes the crawl's
--    P95 page-load time (sourced from `crawl_snapshots.loadMs`, persisted
--    by B1.3) and clamps `2 * p95LoadMs` to
--    `[HEALING_ELEMENT_TIMEOUT, MAX_ELEMENT_TIMEOUT]`. The vm sandbox
--    receives the resulting `elementTimeout` via the injected helper
--    constant (see `selfHealing.js#getSelfHealingHelperCode`).
--    `elementTimeoutOverride` is the per-project escape hatch operators
--    use when they already know their environment's timing (null = use
--    adaptive).
--
-- Rollback:
--   ALTER TABLE projects DROP COLUMN iframeStrategy;
--   ALTER TABLE projects DROP COLUMN iframeAllowlist;
--   ALTER TABLE projects DROP COLUMN hydrationType;
--   ALTER TABLE projects DROP COLUMN hydrationSelector;
--   ALTER TABLE projects DROP COLUMN elementTimeoutOverride;
--   ALTER TABLE runs     DROP COLUMN p95LoadMs;
-- (SQLite ≥3.35 supports DROP COLUMN; older deployments must rebuild the
-- table. Mirrors the rollback convention from migration 067.)
--
-- Convention: `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite.
-- The migration runner (`migrate.js`) tolerates "duplicate column name"
-- errors so re-running this file is safe on already-migrated DBs.

ALTER TABLE projects ADD COLUMN iframeStrategy TEXT NOT NULL DEFAULT 'same-origin';
ALTER TABLE projects ADD COLUMN iframeAllowlist TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN hydrationType TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE projects ADD COLUMN hydrationSelector TEXT;
ALTER TABLE projects ADD COLUMN elementTimeoutOverride INTEGER;

ALTER TABLE runs ADD COLUMN p95LoadMs INTEGER;
