import { incrWithExpiry, isRedisAvailable } from "../utils/redisClient.js";
import { aiRateLimitedTotal } from "../utils/metrics.js";

const DEFAULT_WINDOW_SEC = 60;
const DEFAULT_LIMIT = Number.parseInt(process.env.AI_RATE_LIMIT_PER_MIN || "300", 10) || 300;

const AI_ROUTE_MATCHERS = [
  /^\/api\/v1\/chat$/,
  /^\/api\/v1\/tests\/generate$/,
  /^\/api\/v1\/projects\/[^/]+\/crawl$/,
  /^\/api\/v1\/tests\/[^/]+\/regenerate$/,
  /^\/api\/v1\/settings\/agent-roles\/[^/]+\/test$/,
];

function isAiRoute(req) {
  if (req.method !== "POST") return false;
  const p = req.originalUrl.split("?")[0];
  return AI_ROUTE_MATCHERS.some((rx) => rx.test(p));
}

export function aiRateLimit({ windowSec = DEFAULT_WINDOW_SEC, limit = DEFAULT_LIMIT, costFn } = {}) {
  const getCost = typeof costFn === "function" ? costFn : () => 10;
  return async function aiRateLimitMiddleware(req, res, next) {
    if (!isAiRoute(req)) return next();
    if (!isRedisAvailable()) return next();
    const workspaceId = req.workspaceId || req.authWorkspaceId || null;
    if (!workspaceId) return next();
    const cost = Math.max(1, Number.parseInt(String(getCost(req) || 10), 10) || 10);
    const key = `sentri:rl:wsai:${workspaceId}`;
    try {
      const { value, ttlSec } = await incrWithExpiry(key, cost, windowSec);
      if (value > limit) {
        try { aiRateLimitedTotal.inc({ workspace_role: req.workspaceRole || "unknown" }); } catch {}
        if (ttlSec > 0) res.setHeader("Retry-After", String(ttlSec));
        return res.status(429).json({ error: "AI workspace rate limit exceeded. Please retry later." });
      }
      return next();
    } catch {
      return next();
    }
  };
}

export const _internal = { isAiRoute, AI_ROUTE_MATCHERS };
