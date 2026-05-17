-- Migration 009: Cross-browser support (DIF-002)
--
-- Records the browser engine each run used for test execution so the Run
-- Detail page can show a per-run badge and analytics can break down pass
-- rate by browser.
--
-- Values: "chromium" (default), "firefox", "webkit".
-- Rows created before this migration ran have NULL `browser`; the frontend
-- renders them as "chromium" for backward compatibility with pre-DIF-002
-- history.

ALTER TABLE runs ADD COLUMN browser TEXT;
