/**
 * @module middleware/aiRateLimit
 * @description Per-workspace, cost-weighted limiter for AI-heavy routes.
 */

import { incrWithExpiry } from "../utils/redisClient.js";
import { aiRateLimitedTotal } from "../utils/metrics.js";

function parsePositiveEnv(name, fallback, min = 1, max = 10000) {
  const value = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * Return the default AI-route cost for a request.
 *
 * The middleware is mounted POST-only at `backend/src/index.js` via
 * `app.post(aiMutationPaths, ...)`, so in production this function only ever
 * sees `req.method === "POST"` and the `return 1` branch is unreachable on
 * the live request path. The branch is kept as defence-in-depth: if a future
 * caller mounts the limiter more broadly (e.g. `app.use(...)` on the same
 * paths) or wires it under a different router, non-POST requests must still
 * pass `cost >= 1` to satisfy `incrWithExpiry`'s contract. Callers wiring a
 * custom limiter scope can supply their own `costFn` to override the default.
 *
 * @param {Object} req
 * @returns {number}
 */
export function defaultAiCost(req) {
  if (req.method === "POST") return 10;
  return 1;
}

/**
 * Build middleware that enforces a per-workspace AI-rate budget.
 *
 * Uses a SINGLE per-workspace token bucket with cost-weighted increments —
 * AI mutations consume more tokens than regular calls (per `costFn`), but
 * both draw from the same `${workspaceId}:ai` budget against the same cap.
 * An earlier shape kept two caps (`aiCap` / `regularCap`) keyed off cost
 * but persisted to the SAME Redis key, which produced inconsistent
 * enforcement when the caps differed (the IETF `RateLimit-Limit` header
 * also flickered between values within a window). Industry pattern is one
 * key → one cap, with cost-weighting differentiating call classes inside
 * that single budget — matches Vercel AI Gateway, Cursor, OpenRouter.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.costFn]
 * @param {number} [opts.windowSec]
 * @param {number} [opts.cap]
 * @returns {Function}
 */
export function aiRateLimit(opts = {}) {
  const costFn = opts.costFn || defaultAiCost;
  const windowSec = opts.windowSec || parsePositiveEnv("AI_RATE_LIMIT_WINDOW_SEC", 60, 1, 3600);
  // `AI_RATE_LIMIT_PER_MIN` is the canonical knob (300 cost units / minute /
  // workspace by default = 30 AI mutations OR 300 regular calls / minute).
  // Legacy `AI_RATE_LIMIT_REGULAR_PER_MIN` is accepted for backward
  // compatibility but the value is unused — see the JSDoc above for why.
  const cap = opts.cap || parsePositiveEnv("AI_RATE_LIMIT_PER_MIN", 300, 1, 100000);

  return async function sentriAiRateLimit(req, res, next) {
    try {
      const workspaceId = req.workspaceId || req.user?.workspaceId;
      if (!workspaceId) return next();
      const cost = Math.max(1, Number.parseInt(costFn(req), 10) || 1);
      const key = `${workspaceId}:ai`;
      const { value, ttl } = await incrWithExpiry(key, cost, windowSec);
      // IETF draft "ratelimit-headers" + GitHub / Stripe / OpenAI convention.
      // Emit on every response (not just 429) so well-behaved clients can
      // pre-emptively back off before tripping the cap. `Remaining` clamps
      // at 0 on the rejecting request so clients don't see negatives.
      const remaining = Math.max(0, cap - value);
      res.setHeader("RateLimit-Limit", String(cap));
      res.setHeader("RateLimit-Remaining", String(remaining));
      res.setHeader("RateLimit-Reset", String(ttl));
      if (value > cap) {
        const role = req.workspaceRole || req.userRole || req.user?.role || "unknown";
        aiRateLimitedTotal.inc({ workspace_role: role });
        res.setHeader("Retry-After", String(ttl));
        return res.status(429).json({ error: "AI rate limit exceeded. Please wait before trying again." });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
