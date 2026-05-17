-- SEC-007: seed the system sentinel workspace row + matching owner user.
--
-- The `activities` table has a FOREIGN KEY on `workspaceId → workspaces.id`
-- (migration 005). When `auth.login.failed` fires for an unknown email,
-- `routes/auth.js` tags the row with `SYSTEM_WORKSPACE_ID = "__system__"` so
-- the row stays queryable via `GET /api/v1/system/security-events` instead
-- of being orphaned (workspaceId NULL → invisible to every scoped query).
--
-- That tag only works if the referenced row exists. Without this seed,
-- every unknown-email failed-login INSERT triggers `FOREIGN KEY constraint
-- failed` and the route returns 500 instead of the documented 401.
--
-- ── System user ────────────────────────────────────────────────────────────
-- `workspaces.ownerId` has `NOT NULL` + FK to `users(id)` (migration 005), so
-- the system workspace needs an owner row. We create a sentinel user that:
--   - Has no passwordHash → password login impossible (verifyPassword would
--     fail against the dummy hash, returning 401 like any other unknown user).
--   - Has an `.invalid` email per RFC 6761 §6.4 (reserved TLD, never
--     resolves, can never receive verification mail).
--   - Has a unique email guaranteed by the existing `idx_users_email` index.
INSERT OR IGNORE INTO users (id, name, email, passwordHash, role, createdAt, updatedAt)
VALUES (
  '__system__',
  'System',
  '__system__@__system__.invalid',
  NULL,
  'system',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);

-- ── System workspace ───────────────────────────────────────────────────────
-- The workspace itself:
--   - Slug `__system__` cannot collide with user-generated slugs — slugify()
--     in `workspaceRepo.js` strips non-alphanumerics, so no real workspace
--     can ever produce a slug containing underscores.
--   - NOT listed by `workspaceRepo.getByUserId(userId)` for any human user
--     because no workspace_members row links any user to it. Real users
--     never see this workspace in the switcher.
INSERT OR IGNORE INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt)
VALUES (
  '__system__',
  'System (auto-managed)',
  '__system__',
  '__system__',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);
