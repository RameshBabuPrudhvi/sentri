# Provider Routes — Operator Guide

Add a new LLM vendor to Sentri with zero code edits. Each route bundles
protocol + endpoint + model + encrypted API key into one record that
agent roles dispatch against.

## Quick start

1. **Settings → Provider Routes → Create.**
2. Pick a **family** (anthropic / openai / google / openrouter / local / custom) and **protocol** (the wire format the endpoint speaks).
3. Enter the **model** id (e.g. `claude-3-5-sonnet`, `gpt-4o-mini`).
4. Paste the **API key** — encrypted at rest via AES-256-GCM; only `••••<lastFour>` is ever displayed.
5. Click **Create**. The platform auto-probes the route (B2.2) and shows a green/red reachability badge within seconds.
6. **Settings → Agent Roles** — assign the new route to any pipeline role (`planner`, `author`, `healer`, etc.).

## Route fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Human-readable label, unique per workspace. |
| `family` | Yes | Provider family enum: `anthropic`, `openai`, `google`, `openrouter`, `local`, `custom`. |
| `protocol` | Yes | Wire protocol: `openai`, `anthropic`, `gemini`, `ollama`. Compat endpoints use `openai`. |
| `model` | Yes | Model id sent to the provider SDK. |
| `baseUrl` | No | Override the SDK's default endpoint. Required for self-hosted / proxy deployments. |
| `apiKey` | No | Write-only. Encrypted before persist; only `lastFour` round-trips. Ollama routes are legitimately keyless. |
| `enabled` | — | Toggle dispatch eligibility without deleting the route. |
| `rpmLimit` | No | Requests-per-minute throttle. `null` = unlimited. |
| `tpmLimit` | No | Tokens-per-minute throttle. `null` = unlimited. |
| `cacheEnabled` | — | Opt in to exact-match response caching. |
| `cacheTtlSec` | — | Cache TTL in seconds. `0` disables even with `cacheEnabled`. |
| `fallbackRouteId` | No | Self-referential fallback chain. Cycle-protected at save time (`ERR_ROUTE_FALLBACK_CYCLE`). |
| `pricing` | No | `{ inputPerMtok, outputPerMtok, currency }` — operator-set per-Mtok rates. When null, `MODEL_PRICING` catalog is the fallback. |

## Capability probe

Every route save (create / update with routing-relevant field changes) auto-fires a real 1-token network probe via `protocolAdapter.generate`. The probe checks:

- **Reachable** — can we reach the endpoint at all?
- **Auth** — is the key valid? (401/403 → false)
- **Model** — does the model id resolve? (404 → false)
- **JSON mode** — does `responseFormat: "json_object"` work?
- **Vision** — from the static catalog (cost-justified; no image sent).

Results persist to `provider_routes.capabilities` and drive the Settings UI green/red badge. Re-probe manually via the **Test** button or `POST /api/v1/settings/provider-routes/:id/probe`.

## Key rotation

**Settings → Provider Routes → Rotate key** (or `POST /api/v1/settings/provider-routes/:id/rotate-key`).

1. Encrypts the new plaintext.
2. Writes the new ciphertext to the route.
3. Runs a network probe against the new key.
4. If the probe fails → rolls back to the prior ciphertext. The operator sees the failure reason.
5. If the probe passes → clears all circuit breakers keyed off the route so dispatch retries immediately.

Audit trail: every rotation emits `action: "rotate_key"` with `metadata: { lastFour }` (never the ciphertext).

## JSON import / export

- **Export**: `GET /settings/provider-routes/export` — downloads a schema-v1 JSON file. Secrets are NEVER included (only `apiKeyLastFour`).
- **Import**: `POST /settings/provider-routes/import` with `{ schemaVersion, routes, mode }`. Modes:
  - `skip` — existing names untouched.
  - `overwrite` — replace by name (preserves stored keys when not in payload).
  - `rename` — append `-2`, `-3` on collision.
- Each imported route is auto-probed with bounded parallelism (3 concurrent).

## Rate limits + spend caps

Per-route: `rpmLimit` / `tpmLimit` on the route row. Pre-call `checkAndReserve` rejects with `ERR_RATE_LIMIT_LOCAL` before burning provider quota; post-call `reportActual` corrects drift.

Per-workspace: `dailySpendCapUsd` / `monthlySpendCapUsd` on the workspace row. `checkSpendCap` sums realised cost from `ai_request_log` over rolling 24h / month-to-date windows. Alert fires at `spendAlertThresholdPct` (default 80%).

Set via **Settings → Provider Routes → Workspace spend caps** panel or `PATCH /workspaces/current`.

## Response caching

Per-route opt-in via `cacheEnabled` + `cacheTtlSec`. Exact-match keyed by `sha256(routeId + model + stableJSON({messages, maxTokens, temperature, responseFormat}))`.

- Streaming calls are never cached.
- `skipCache: true` per-call opt-out (used by self-healing).
- Thundering-herd protection: concurrent identical misses coalesce into one provider call.
- Daily janitor sweeps expired rows at 04:30 UTC.
- Metrics: `app_ai_cache_hits_total`, `app_ai_cache_misses_total`, `app_ai_cache_savings_usd_total`.

## Audit log

Every mutation (create / update / delete / rotate_key / probe / export / import) appends a `provider_route_audit` row. View via **Settings → Provider Routes → Audit log** subtab or `GET /api/v1/settings/provider-routes/audit`. Retention: 90 days default (`SENTRI_AUDIT_RETENTION_DAYS`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Badge shows red after create | Key invalid or model doesn't exist on the endpoint | Click Test to see `errorReason`; fix the key or model id |
| `ERR_RATE_LIMIT_LOCAL` on dispatch | Route's `rpmLimit` or `tpmLimit` exceeded | Raise the limit or add a second route with the same model |
| `ERR_SPEND_CAP_EXCEEDED` | Workspace daily or monthly cap reached | Raise the cap or wait for the window to roll |
| Import shows `skipped: N` | Names already exist and mode is `skip` | Re-import with mode `overwrite` or `rename` |
| Rotate key returns 400 "Probe failed" | New key doesn't work against the endpoint | Verify the key out-of-band; the old key is restored automatically |
| Cache hit rate is 0% | `cacheEnabled` is off or `cacheTtlSec` is 0 | Enable caching on the route and set a positive TTL |
