# AI Request Log — Operations Guide

Sentri logs every AI dispatch call to the `ai_request_log` table for
per-call observability, billing reconciliation, and prompt replay.

## Storage modes

Each workspace controls how much prompt/response content is persisted.
Set via **Settings → AI Providers** (admin) or direct SQL on the
`workspaces.aiRequestLogMode` column.

| Mode | Prompt/response stored | Replay available | Default |
|---|---|---|---|
| `none` | NULL (metadata only: hash, tokens, cost, latency, outcome) | ❌ | ✅ |
| `redacted` | PII-stripped via built-in + custom regex rules | ❌ (sentinels are not meaningful) | |
| `full` | Raw prompt + response | ✅ | |

Single-tenant fallback: set `AI_REQUEST_LOG_STORAGE_MODE=redacted` (or
`full`) in `backend/.env` to override the workspace default for
deployments that haven't migrated to per-workspace settings.

## PII redaction pipeline

When mode is `redacted`, the following built-in patterns fire before
persist:

| Pattern | Sentinel |
|---|---|
| Email (`user@example.com`) | `[REDACTED_EMAIL]` |
| Phone (international + national) | `[REDACTED_PHONE]` |
| US SSN (`123-45-6789`) | `[REDACTED_SSN]` |
| Credit card (13–19 digits) | `[REDACTED_CARD]` |

### Custom workspace rules

Admins can add workspace-specific regex rules by writing a JSON array
to `workspaces.aiRequestLogCustomRedactionRules`:

```json
[
  { "pattern": "internal-id-\\d+", "flags": "g", "replacement": "[REDACTED_ID]" },
  { "pattern": "proj-\\w+", "flags": "gi" }
]
```

- `pattern` — JS `RegExp` constructor string (double-escape backslashes).
- `flags` — optional, defaults to `"g"`.
- `replacement` — optional, defaults to `"[REDACTED_CUSTOM]"`.
- Malformed patterns are silently skipped — built-in redactors still fire.

Custom rules apply **after** the built-in patterns.

## Replay

`POST /api/v1/settings/ai-requests/:id/replay` re-issues a logged
prompt against any route.

**Requirements:**
- The log row must have been captured under `full` storage mode.
  Rows captured under `none` (no prompt) or `redacted` (sentinel
  strings) are rejected with HTTP 400.
- Optional `routeId` body parameter dispatches directly against the
  specified route via `protocolAdapter.generate`, bypassing role
  resolution. Useful for "would this prompt work better on a different
  model?" debugging.
- Replays are billed at the route's regular rate. The replay itself
  is logged to `ai_request_log` under `full` mode so it's replayable
  in turn.

## Retention

A daily 04:30 UTC sweep deletes `ai_request_log` rows older than
`AI_REQUEST_LOG_RETENTION_DAYS` (default 30). Set `0` to disable.

## Columns

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | `air-<uuid>` |
| `workspaceId` | TEXT NOT NULL | FK → `workspaces(id)` |
| `routeId` | TEXT | FK → `provider_routes(id)`, NULL on env-default calls |
| `agentRole` | TEXT | Pipeline role (`planner`, `author`, etc.) |
| `userId` | TEXT | Operator who triggered the call (when available) |
| `promptHash` | TEXT NOT NULL | SHA-256 of the raw prompt |
| `promptRedacted` | TEXT | NULL (`none`), redacted (`redacted`), or raw (`full`) |
| `responseRedacted` | TEXT | Same semantics as `promptRedacted` |
| `inputTokens` | INTEGER | From adapter `usage.input` |
| `outputTokens` | INTEGER | From adapter `usage.output` |
| `costUsd` | REAL | From `computeCostForRoute(route, usage)` |
| `latencyMs` | INTEGER | Wall-clock ms from call start to adapter return |
| `outcome` | TEXT | `success` / `error` / `rate_limited` |
| `errorReason` | TEXT | Classified error reason on failure |
| `traceId` | TEXT | OTel trace id for cross-system correlation |
| `createdAt` | TEXT NOT NULL | ISO-8601 timestamp |

Indexed on `(workspaceId, createdAt)` and `traceId`.

## Querying

`GET /api/v1/settings/ai-requests` (admin) supports:

| Filter | Query param |
|---|---|
| Route | `routeId=pr-...` |
| Role | `agentRole=planner` |
| Trace | `traceId=abc123` |
| Outcome | `outcome=error` |
| Cursor | `before=2024-01-15T00:00:00.000Z` |
| Limit | `limit=50` (max 200) |

Response: `{ items: [...], nextCursor }`.
