/**
 * @module constants/activityTypes (frontend)
 * @description Frontend copy of the `activities.type` literals.
 *
 * **Keep in sync with `backend/src/constants/activityTypes.js`** — the
 * canonical source. This file duplicates the enum because the frontend
 * and backend Docker images each only copy their own directory
 * (`frontend/Dockerfile` copies `frontend/`; `backend/Dockerfile` copies
 * `backend/`), so neither image can reach a sibling `shared/` dir or
 * cross-import into the other package's tree at build time.
 *
 * A workspace package (`packages/shared`) would remove the duplication
 * but forces a monorepo restructure for what is currently a 14-string
 * map. Revisit if the shared surface grows.
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

  // SEC-007: meta-audit — reads / exports of the audit log itself.
  // Required by PCI-DSS 10.2.6 and SOC 2 CC7.2.
  AUDIT_READ:         "audit.read",
  AUDIT_EXPORT:       "audit.export",
});
