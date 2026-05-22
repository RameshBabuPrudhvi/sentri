/**
 * @module utils/notificationCoerce
 * @description Pure-JS helpers extracted from `context/NotificationContext.jsx`
 * so they can be unit-tested under Node without React / jsdom. The React file
 * re-exports + composes these — single source of truth for the coercion logic.
 *
 * The helpers exist because some callsites historically passed `Error`
 * instances or API envelopes (`{ type, message }`) to `addNotification()`,
 * which rendered as the literal `"[object Object]"` once persisted to
 * localStorage. Defence-in-depth: coerce at write time AND sanitize legacy
 * persisted entries at read time.
 */

/**
 * Coerce arbitrary input to a readable string for notification title/body.
 *
 * @param {unknown} value
 * @param {string} field   Field name used in the dev warning ("title" | "body").
 * @param {Function} [warn]  Optional dev-mode warning hook. Tests inject this
 *   to assert that non-string inputs trigger a warning at the offending
 *   callsite. Production callers should leave it undefined so the helper
 *   itself decides whether to emit (gated on `import.meta.env.DEV` at the
 *   React-file layer that wraps this).
 * @returns {string}
 */
export function coerceText(value, field = "value", warn) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (typeof warn === "function") {
    try { warn(field, value); } catch { /* ignore — best-effort */ }
  }

  if (value instanceof Error) return value.message || value.toString();
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.title === "string") return value.title;
    if (typeof value.error === "string") return value.error;
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return String(value);
}

/**
 * True if a stored string looks like the result of `Object.prototype.toString()`.
 * Used to sanitize legacy `localStorage` entries on read.
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function isBadStringified(s) {
  return typeof s === "string" && (s === "[object Object]" || s.startsWith("[object "));
}
