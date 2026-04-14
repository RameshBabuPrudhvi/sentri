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
    } : null,
  };
}
