/**
 * @module utils/validate
 * @description Lightweight input validation helpers for API routes.
 *
 * No external dependencies — keeps the backend lean. Each function returns
 * `null` if valid, or an error message string if invalid.
 *
 * @example
 * const err = validate.projectPayload(req.body);
 * if (err) return res.status(400).json({ error: err });
 */

/**
 * Trim and truncate a string. Returns empty string for non-string values.
 * @param {*} val
 * @param {number} [maxLen=500]
 * @returns {string}
 */
export function sanitise(val, maxLen = 500) {
  return typeof val === "string" ? val.trim().slice(0, maxLen) : "";
}

/**
 * Validate a URL string — must be http or https.
 * @param {string} url
 * @returns {string|null} Error message or null.
 */
export function validateUrl(url) {
  if (!url || typeof url !== "string") return "URL is required.";
  try {
    const parsed = new URL(url.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "URL must use http or https protocol.";
    }
    return null;
  } catch {
    return "Invalid URL format. Must be a valid URL (e.g. https://example.com).";
  }
}

/**
 * Validate project creation/update payload.
 * @param {Object} body - req.body
 * @returns {string|null} Error message or null.
 */
export function validateProjectPayload(body) {
  if (!body || typeof body !== "object") return "Request body is required.";
  const name = sanitise(body.name, 200);
  if (!name) return "Project name is required.";
  if (name.length < 1 || name.length > 200) return "Project name must be 1–200 characters.";
  const urlErr = validateUrl(body.url);
  if (urlErr) return urlErr;

  // Validate credentials if provided
  if (body.credentials) {
    const c = body.credentials;
    if (typeof c !== "object") return "Credentials must be an object.";
    if (c.usernameSelector && typeof c.usernameSelector !== "string") return "usernameSelector must be a string.";
    if (c.username && typeof c.username !== "string") return "username must be a string.";
    if (c.passwordSelector && typeof c.passwordSelector !== "string") return "passwordSelector must be a string.";
    if (c.password && typeof c.password !== "string") return "password must be a string.";
    if (c.submitSelector && typeof c.submitSelector !== "string") return "submitSelector must be a string.";
  }
  return null;
}

/**
 * Validate manual test creation payload.
 * @param {Object} body - req.body
 * @returns {string|null} Error message or null.
 */
export function validateTestPayload(body) {
  if (!body || typeof body !== "object") return "Request body is required.";
  const name = sanitise(body.name, 500);
  if (!name) return "Test name is required.";
  if (body.steps && !Array.isArray(body.steps)) return "Steps must be an array.";
  if (body.steps && body.steps.length > 100) return "Maximum 100 steps per test.";
  if (body.steps && body.steps.some(s => typeof s !== "string")) return "Each step must be a string.";
  if (body.priority && !["low", "medium", "high"].includes(body.priority)) return "Priority must be low, medium, or high.";
  if (body.type && typeof body.type !== "string") return "Type must be a string.";
  return null;
}

/**
 * Validate test update (PATCH) payload.
 * @param {Object} body - req.body
 * @returns {string|null} Error message or null.
 */
export function validateTestUpdate(body) {
  if (!body || typeof body !== "object") return "Request body is required.";
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) return "Name must be a non-empty string.";
  if (body.steps !== undefined && !Array.isArray(body.steps)) return "Steps must be an array.";
  if (body.steps && body.steps.length > 100) return "Maximum 100 steps per test.";
  if (body.priority !== undefined && !["low", "medium", "high"].includes(body.priority)) return "Priority must be low, medium, or high.";
  if (body.tags !== undefined && !Array.isArray(body.tags)) return "Tags must be an array.";
  if (body.tags && body.tags.length > 20) return "Maximum 20 tags per test.";
  return null;
}

/**
 * Validate bulk test action payload.
 * @param {Object} body - req.body
 * @returns {string|null} Error message or null.
 */
export function validateBulkAction(body) {
  if (!body || typeof body !== "object") return "Request body is required.";
  if (!Array.isArray(body.testIds) || body.testIds.length === 0) return "testIds must be a non-empty array.";
  if (body.testIds.length > 500) return "Maximum 500 tests per bulk action.";
  if (body.testIds.some(id => typeof id !== "string")) return "Each testId must be a string.";
  if (!["approve", "reject", "restore", "delete"].includes(body.action)) return "Action must be approve, reject, restore, or delete.";
  return null;
}
