# Quotas, Spend Caps & Response Caching — Operations Guide

## Per-route rate limits (B3.7)

Each `provider_routes` row carries optional `rpmLimit` (requests/min)
and `tpmLimit` (tokens/min) columns. When set, the dispatcher's
`quotaGuard.checkAndReserve(routeId, estimatedTokens)` runs **before**
the provider SDK call — a rejected call never burns vendor quota.

### Token-bucket mechanics

- **Lazy refill** — buckets replenish proportionally to elapsed time
  since the last call. No background timer; idle routes cost zero CPU.
- **Dual-dimension** — RPM and TPM are checked independently; the
  call is rejected if *either* dimension is exhausted.
- **Post-call drift correction** — `reportActual(routeId, estimated,
  actual)` adjusts the token bucket after the SDK returns so over- or
  under-estimates converge to the truth after one call.

### In-memory vs Redis

| Deployment | Bucket storage | Config |
|---|---|---|
| Single replica | In-memory `Map` (default) | Nothing to set |
| Multi-replica | Redis atomic Lua script | Set `REDIS_URL` |

Redis path uses `EVAL` so two replicas can never both succeed when
only one unit of capacity remains. Fail-open: if Redis is down, the
in-memory path runs as fallback (logged at warn level).

### Error shape

```json
{
  "code": "ERR_RATE_LIMIT_LOCAL",
  "message": "Local rate limit reached on route anthropic-prod. Retry after 2400ms.",
  "retryAfterMs": 2400,
  "reason": "tpm"
}
```

## Per-workspace spend caps (B3.7)

| Column | Type | Default | Description |
|---|---|---|---|
| `dailySpendCapUsd` | REAL | NULL (unlimited) | Rolling 24h USD cap |
| `monthlySpendCapUsd` | REAL | NULL (unlimited) | Month-to-date (calendar-month UTC) USD cap |
| `spendAlertThresholdPct` | INTEGER | 80 | Alert fires when spend crosses `cap × pct/100` |

Set via **Settings → AI Providers → Spend Caps** tab or
`PATCH /api/v1/workspaces/current`.

### How spend is measured

`checkSpendCap(workspaceId)` sums `ai_request_log.costUsd` over the
relevant window. Every AI call writes a log row (even under `mode:
"none"`) with the cost from `computeCostForRoute(route, usage)`.

### Error shape

```json
{
  "code": "ERR_SPEND_CAP_EXCEEDED",
  "message": "Spend cap exceeded (day). Dispatch blocked until next 24h window.",
  "exceeded": "day",
  "remainingUsd": -2.34
}
```

### Spend alert

When `currentSpend >= cap × thresholdPct / 100`, the dispatcher logs a
warning with daily + monthly spend vs. cap. Slack/webhook integration
is planned for a follow-up commit.

## Response caching (B3.8)

### Enabling

Set `cacheEnabled = true` and `cacheTtlSec > 0` on the route row
(via Settings → AI Providers UI or `PATCH /settings/ai-providers/:id`).

### Cache key

`sha256(routeId + model + stableJSON({messages, maxTokens, temperature,
responseFormat}))` — deterministic, sorted-key serialisation so
`{a:1, b:2}` and `{b:2, a:1}` produce the same key.

### What's NOT cached

- Streaming calls (`streamText`) — silently skipped.
- Calls with `skipCache: true` — used by self-healing where stale
  answers are dangerous.
- Routes with `cacheEnabled = 0` or `cacheTtlSec <= 0`.

### Thundering-herd protection

Identical concurrent cache misses coalesce: the first caller dispatches,
the rest await the same Promise. When it resolves, all callers get the
same response and the cache is populated once.

### Eviction

TTL only — no LRU. Expired rows are swept by the daily 04:30 UTC
janitor (`scheduler.js`). `getCached` also double-checks `expiresAt`
on every read so a hit on an expired row never returns stale data.

### Metrics

| Metric | Description |
|---|---|
| `app_ai_cache_hits_total{route_name, agent_role}` | Cache hits |
| `app_ai_cache_misses_total{route_name, agent_role}` | Cache misses (cold + expired) |
| `app_ai_cache_savings_usd_total{route_name, agent_role}` | Cumulative USD saved |

Hit rate = `hits / (hits + misses)`.

### Tuning

| Knob | Effect |
|---|---|
| `cacheTtlSec` | Longer → higher hit rate, risk of stale answers |
| `temperature: 0` | Deterministic output → maximum hit rate |
| `skipCache: true` on self-healing calls | Prevents stale heals |
| Janitor frequency | Daily at 04:30 UTC; not configurable yet |
