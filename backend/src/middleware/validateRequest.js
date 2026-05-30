/**
 * @module middleware/validateRequest
 * @description §17 #7 / TD-017 — Reusable Zod request-validation middleware.
 *
 * Replaces the hand-rolled `if (!req.body.name || typeof req.body.name !== "string")`
 * guards that are scattered across `routes/*.js` today (8+ distinct phrasings,
 * inconsistent error shapes). A single Zod schema becomes the source of truth
 * for: input coercion, type narrowing, the OpenAPI spec (via `zod-to-openapi`
 * when that lands), and the wire-format error response shape.
 *
 * ### Adoption strategy
 *
 * This middleware is opt-in per route. Each route file migrates incrementally
 * by replacing its hand-rolled guard with:
 *
 *   import { validateBody } from "../middleware/validateRequest.js";
 *   import { z } from "zod";
 *
 *   const CreateProjectSchema = z.object({
 *     name: z.string().min(1).max(200),
 *     url:  z.string().url(),
 *   });
 *
 *   router.post("/", validateBody(CreateProjectSchema), (req, res) => {
 *     // req.body is now the parsed + coerced shape — safe to consume
 *   });
 *
 * The hand-rolled guard stays for any route that hasn't migrated yet. No
 * big-bang refactor needed.
 *
 * ### Error contract
 *
 * On a validation failure the middleware responds with HTTP 400 and a body
 * loosely modelled on RFC 9457 (problem+json minus the IANA URN type):
 *
 *   {
 *     "error":   "valid email is required",
 *     "code":    "validation_failed",
 *     "message": "Request body failed schema validation",
 *     "details": [
 *       { "path": "body.email", "message": "valid email is required", "code": "invalid_string" },
 *       …
 *     ]
 *   }
 *
 * The `error` field carries the FIRST detail's human-readable message so
 * frontend consumers that display `body.error` directly (toasts, banners)
 * get actionable text without needing to parse the `details` array. The
 * machine-readable identifier moves to `code: "validation_failed"`, which
 * matches the rest of the codebase's pattern of pairing a free-text
 * `error` with a stable `code` (see `routes/auth.js` `MFA_ENROLLMENT_REQUIRED`,
 * `routes/tests.js` `ZIP_BINARY_MISSING`, etc.).
 *
 * `details` is intentionally an array (not a single error) so multi-field
 * forms can surface every issue in one round-trip — matches the behaviour
 * frontend validation libraries (Formik / RHF) expect.
 *
 * ### Exports
 *
 * - {@link validateBody}   — body schema → 400 on parse failure, `req.body` replaced with parsed shape
 * - {@link validateQuery}  — same shape, against `req.query`
 * - {@link validateParams} — same shape, against `req.params`
 *
 * Each takes a Zod schema and returns an Express middleware. Composable
 * with existing middleware chains (requireAuth, requireRole, etc.) — order
 * doesn't matter; the validator only touches the `req.<part>` it's keyed on.
 */

import { z } from "zod";

/**
 * Map a `ZodIssue[]` to the wire `details` array. Bounded to the surface
 * the caller actually needs — Zod's full issue object includes vendor
 * internals (`unionErrors`, `expected`, `received`) that leak schema
 * structure to attackers and bloat the response.
 *
 * @param {Array<Object>} issues — Zod's `ZodIssue[]` array.
 * @param {string} location — `"body"` | `"query"` | `"params"`.
 * @returns {Array<Object>} Each entry is `{ path, message, code }`.
 */
function formatIssues(issues, location) {
  return issues.map((issue) => ({
    path: [location, ...issue.path].join("."),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Internal factory — both `validateBody` / `validateQuery` / `validateParams`
 * share the same parse-and-replace pattern, just keyed on a different
 * property of the Express `req` object.
 *
 * @param {string} location — `"body"` | `"query"` | `"params"`.
 * @param {Object} schema — A Zod schema (any `ZodTypeAny`).
 * @returns {Function} Express middleware `(req, res, next) => void`.
 */
function makeValidator(location, schema) {
  // Fail loudly at registration time if the caller passes a non-Zod schema —
  // a typo like `validateBody({ name: z.string() })` (forgetting the
  // `z.object(...)` wrapper) would silently accept every request otherwise.
  if (!schema || typeof schema.safeParse !== "function") {
    throw new TypeError(
      `[validateRequest] ${location} schema is not a Zod schema (no .safeParse() method)`,
    );
  }
  return function validate(req, res, next) {
    const result = schema.safeParse(req[location]);
    if (!result.success) {
      const details = formatIssues(result.error.issues, location);
      // Surface the first issue's message as the top-level `error` field so
      // frontend consumers that show `body.error` (e.g. MembersSection's
      // `showToast(err.message || …)`) display actionable text instead of
      // the machine code. See "Error contract" in the module doc above.
      return res.status(400).json({
        error: details[0]?.message || `Request ${location} failed schema validation`,
        code: "validation_failed",
        message: `Request ${location} failed schema validation`,
        details,
      });
    }
    // Replace `req[location]` with the parsed (coerced + stripped) shape so
    // downstream handlers consume the schema's projection, not the raw input.
    // This is the whole point of using Zod over hand-rolled guards — once
    // it passes, the handler has a typed value.
    //
    // Note: `req.query` and `req.params` are writable in Express 4 (they're
    // plain objects). Express 5 freezes them — when we upgrade, switch to
    // `req.locals.validated.<location>` and update consumers in lockstep.
    req[location] = result.data;
    next();
  };
}

/**
 * Validate `req.body` against a Zod schema.
 * On failure: 400 with the `validation_failed` shape documented above.
 * On success: `req.body` is replaced with the parsed shape.
 *
 * @param {Object} schema — A Zod schema (any `ZodTypeAny`).
 * @returns {Function} Express middleware.
 */
export function validateBody(schema) {
  return makeValidator("body", schema);
}

/**
 * Validate `req.query` against a Zod schema.
 * Query strings are always `string` (or `string[]` for repeats), so the
 * schema typically uses `z.coerce.number()` / `z.coerce.boolean()` to
 * convert string-typed query params into the expected types.
 *
 * @param {Object} schema — A Zod schema (any `ZodTypeAny`).
 * @returns {Function} Express middleware.
 */
export function validateQuery(schema) {
  return makeValidator("query", schema);
}

/**
 * Validate `req.params` against a Zod schema.
 * Useful for path-param shape pinning (e.g. UUID format).
 *
 * @param {Object} schema — A Zod schema (any `ZodTypeAny`).
 * @returns {Function} Express middleware.
 */
export function validateParams(schema) {
  return makeValidator("params", schema);
}

// Re-export `z` so route files only need one import for "schema + middleware".
export { z };
