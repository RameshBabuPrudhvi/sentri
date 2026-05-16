/**
 * @module constants/activityTypes
 * @description Single source of truth for `activities.type` literals —
 * imported by both the backend (`backend/src/...`) and the frontend
 * (`frontend/src/...`, via a relative path that climbs into `backend/`).
 *
 * Lives under `backend/src/` rather than a repo-root `shared/` directory
 * because the backend Docker image only copies `backend/` — a sibling
 * `shared/` would break the container build. The frontend already
 * reaches into `backend/` via `server.fs.allow: ['..']` in
 * `frontend/vite.config.js`, so cross-side import is unaffected.
 *
 * Imperative `<entity>.<verb>` (`test.approve`, not `test.approved`).
 */

export const ACTIVITY_TYPES = Object.freeze({
  TEST_CREATE:        "test.create",
  TEST_EDIT:          "test.edit",
  TEST_DELETE:        "test.delete",
  TEST_REGENERATE:    "test.regenerate",
  TEST_GENERATE:      "test.generate",
  TEST_APPROVE:       "test.approve",
  TEST_REJECT:        "test.reject",
  TEST_RESTORE:       "test.restore",
  TEST_AUTO_APPROVE:  "test.auto_approve",
  TEST_REVOKE:        "test.revoke",

  TEST_BULK_APPROVE:  "test.bulk_approve",
  TEST_BULK_REJECT:   "test.bulk_reject",
  TEST_BULK_RESTORE:  "test.bulk_restore",
  TEST_BULK_DELETE:   "test.bulk_delete",

  AUTH_LOGIN:         "auth.login",
  AUTH_LOGIN_FAILED:  "auth.login.failed",
  AUTH_LOGOUT:        "auth.logout",
  AUTH_PASSWORD_RESET:"auth.password.reset",
  AUTH_ROLE_CHANGE:   "auth.role.change",
  AUTH_API_KEY_CREATE:"auth.api_key.create",
  AUTH_API_KEY_REVOKE:"auth.api_key.revoke",
  AUTH_SESSION_REVOKE:"auth.session.revoke",
});
