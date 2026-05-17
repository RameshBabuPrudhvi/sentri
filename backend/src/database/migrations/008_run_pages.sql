-- Migration 007: Add pages JSON column to runs table
-- Stores the crawled page list so the site map graph can render from DB
-- instead of relying on in-memory-only data that is lost on page reload.
ALTER TABLE runs ADD COLUMN pages TEXT;
