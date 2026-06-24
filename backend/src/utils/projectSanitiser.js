/**
 * @module utils/projectSanitiser
 * @description Shared helper to strip encrypted credential values from a project
 * before sending it to the client. Used by both project routes and the recycle-bin
 * routes.
 */

/**
 * Strip encrypted credential values from a project before sending to the client.
 * Only returns whether auth is configured, not the actual secrets.
 * @param {Object} project
 * @returns {Object}
 */
export function sanitiseProjectForClient(project) {
  if (!project) return project;
  const { credentials, ...rest } = project;
  return {
    ...rest,
    credentials: credentials ? {
      usernameSelector: credentials.usernameSelector || "",
      passwordSelector: credentials.passwordSelector || "",
      submitSelector: credentials.submitSelector || "",
      _hasAuth: true,
      // B4 (AUDIT-ROADMAP) / SCL-001 — surface presence-only marker so the
      // ProjectSettings panel can render "TOTP configured (•••••)" + a
      // "Test TOTP" button without ever shipping the base32 seed over the
      // wire. The seed itself is only readable inside the AES-encrypted
      // blob server-side; the live code is computed by the dedicated
      // `POST /credentials/test-totp` endpoint and never round-trips with
      // the project resource.
      _hasTotp: !!credentials.totpSecret,
    } : null,
  };
}

/**
 * DIF-012: Strip the password from an environment row before sending to the
 * client. Environments only carry `{ username, password }` (no selectors —
 * the crawler auto-detects login fields), so the safe shape mirrors
 * `sanitiseProjectForClient` minus the selector echo.
 *
 * The router calls `decryptCredentials()` on the stored row first; this
 * helper takes the decrypted result and returns `{ username, _hasAuth: true }`
 * so the EnvironmentsTab can render the username (for at-a-glance "which
 * account is this env using") without ever shipping the secret over the
 * wire. REVIEW.md security checklist explicitly forbids returning plaintext
 * passwords in API responses.
 *
 * @param {Object|null} decryptedCreds - Result of `decryptCredentials(row.credentials)`.
 * @returns {Object|null}
 */
export function sanitiseEnvCredentialsForClient(decryptedCreds) {
  if (!decryptedCreds) return null;
  if (!decryptedCreds.username && !decryptedCreds.password) return null;
  return {
    username: decryptedCreds.username || "",
    _hasAuth: true,
  };
}
