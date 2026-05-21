# AI Provider Evolution — Agent Task Bundles (Industry Standard)
> **Goal:** Operators add a route with `{name, url, model, apiKey}`. N routes per family. Independent fallback per route. Capabilities auto-probed. Pricing optional. JSON import/export. Encrypted secrets, quotas, caching, audit log. No code edits to add a vendor.
>
> **Baseline:** Post PR #22 (AI-005 multi-agent dispatch).
>
> **Design principle:** Production primitives (encryption, quotas, audit, cache, request log) are designed in from Bundle 1 — not bolted on later. Each bundle adds capability without re-touching prior bundles' code.
>
> **Sequencing:** Bundle 1 → 2 → 3 → 4. Each ships as one PR. Bundle 4 (advanced routing) is deferred until requested.

## Bundle status

| Bundle | Status | Notes |
|---|---|---|
| **Bundle 1** | ✅ Shipped (PR #22) | Foundation: schema + audit + secrets + protocol adapter + `resolveRoute` (flag-gated). |
| **Bundle 2** | ✅ Shipped (PR #23) | Migration `provider → routeId` + capability probe + per-route pricing + request log + flag removal. `resolveProvider` deleted. |
| **Bundle 3** | ✅ Shipped (PR #23) | Settings UI + import/export + quotas + cache + key rotation + audit log viewer + compat migration script + spend-alert webhook delivery (migration 052 + `spendAlert.js`). All B3.11 tests shipped. |
| **Bundle 4** | ✅ Shipped (PR #23) | B4.1 hardcoded-string sweep (all dispatch via `protocolAdapter`, `buildProviderMeta` derives from catalog). B4.2 observability parity (alerts pivoted to `route_name`, cardinality budget documented, cache+quota PromQL). B4.3 migration 053 drops `fallbackRole` + compat `api_keys` rows. B4.4 `no-code-edits-contract.test.js` E2E. B4.5 load tests (`dispatch-overhead.js` + `cache-throughput.js`). B4.6 route groups (migration 054 + `routeGroupResolver.js` + `resolveRoute` wiring). B4.7 docs polish (`observability.md`, `provider-routes.md`, `multi-agent-pipeline.md`, `changelog.md`). |
---
# Bundle 1 — Foundation (schema + adapter + resolution + secrets)
**Scope:** Schema with production fields baked in. Encrypted secrets from day one. Protocol-dispatching adapter. Route resolution behind a feature flag.
**Risk:** Additive. Existing `agent_configs.provider` path keeps working via shim.
**PR title:** `feat(ai-provider): provider_routes foundation — schema, encrypted secrets, protocol adapter, resolveRoute`
## Tasks
### B1.1 — `provider_routes` schema (production-ready from day one)
- [ ] Migration `backend/src/database/migrations/NNN_provider_routes.sql`:
  ```sql
  CREATE TABLE provider_routes (
    id TEXT PRIMARY KEY,
    workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    family TEXT NOT NULL,                 -- anthropic|openai|google|ollama|custom
    protocol TEXT NOT NULL,               -- openai|anthropic|gemini|ollama
    baseUrl TEXT,
    model TEXT NOT NULL,
    -- Encrypted secret (B1.4)
    apiKeyEncrypted BLOB,                 -- AES-256-GCM ciphertext
    apiKeyNonce BLOB,
    apiKeyLastFour TEXT,                  -- for UI display ••••abcd
    -- Capabilities (probed in B2)
    capabilities TEXT,                    -- JSON
    -- Pricing (set in B2)
    pricing TEXT,                         -- JSON: { inputPerMtok, outputPerMtok, currency }
    -- Quotas (enforced in B3)
    rpmLimit INTEGER,                     -- null = unlimited
    tpmLimit INTEGER,
    -- Caching (enabled in B3)
    cacheEnabled INTEGER NOT NULL DEFAULT 0,
    cacheTtlSec INTEGER NOT NULL DEFAULT 3600,
    -- Fallback chain
    fallbackRouteId TEXT REFERENCES provider_routes(id) ON DELETE SET NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(workspaceId, name)
  );
  CREATE INDEX idx_provider_routes_workspace ON provider_routes(workspaceId);
  ```
- [ ] All columns added now (nullable where not yet enforced) so later bundles don't run schema migrations on the hot table.
### B1.2 — Audit log schema (also day one)
- [ ] Migration `NNN_provider_route_audit.sql`:
  ```sql
  CREATE TABLE provider_route_audit (
    id TEXT PRIMARY KEY,
    workspaceId TEXT NOT NULL,
    routeId TEXT,
    userId TEXT,
    action TEXT NOT NULL,                 -- create|update|delete|rotate_key|probe|export|import
    metadata TEXT,                        -- JSON, never plaintext keys
    createdAt TEXT NOT NULL
  );
  CREATE INDEX idx_route_audit_workspace ON provider_route_audit(workspaceId, createdAt);
  ```
- [ ] `backend/src/database/repositories/providerRouteAuditRepo.js` — append-only insert + paginated read
### B1.3 — `provider_routes` repo
- [ ] `backend/src/database/repositories/providerRouteRepo.js`:
  - `list / getById / getByName / listByFamily / upsert / delete`
  - Cycle guard on `fallbackRouteId` (pattern from `agentConfigRepo.wouldCreateCycle`)
  - JSON-column helpers for `capabilities` / `pricing`
  - Every mutation emits an audit log entry
  - Throws `ERR_ROUTE_FALLBACK_CYCLE`
### B1.4 — Encrypted secrets at rest
- [ ] `backend/src/aiProvider/secrets.js`:
  - `encryptKey(plaintext) → { ciphertext, nonce, lastFour }` — Node `crypto.createCipheriv` AES-256-GCM
  - `decryptKey(ciphertext, nonce) → plaintext`
  - Master key from `process.env.SENTRI_MASTER_KEY` (32 bytes base64); fail fast if missing in production
  - In-memory plaintext cache with 5-min TTL keyed by `routeId` to avoid per-call decrypt
- [ ] `providerRouteRepo.upsert` encrypts on write; `getById` returns ciphertext, exposes `getDecryptedKey(routeId)` for adapter use only
- [ ] **Never log or return plaintext** — API responses show `apiKeyLastFour` only
- [ ] Master key rotation procedure documented in `docs/operations/secrets-rotation.md`
### B1.5 — Protocol-dispatching adapter
- [ ] `backend/src/aiProvider/adapters/protocolAdapter.js` — single entry, switches on `route.protocol`
- [ ] Extract existing adapters into protocol modules:
  - `backend/src/aiProvider/protocols/openai.js`
  - `backend/src/aiProvider/protocols/anthropic.js`
  - `backend/src/aiProvider/protocols/gemini.js`
  - `backend/src/aiProvider/protocols/ollama.js`
- [ ] Each exports `{ generate(route, messages, opts), stream(route, messages, opts) }`
- [ ] Adapter receives resolved `route` + decrypted key via `secrets.getDecryptedKey` — no env reads
- [ ] Streaming + non-streaming parity
### B1.6 — `resolveRoute` (additive alongside `resolveProvider`)
- [ ] New `resolveRoute({ agentRole, workspaceId })` in `backend/src/aiProvider/registry.js`
  - Returns `{ route, config, effectiveAgentRole }`
  - Priority: sticky-fallback > `agent_configs.routeId` > shim from `agent_configs.provider` > env default
- [ ] Shim: when `agent_configs.provider` is set (pre-B2), synthesize a transient route so dispatch works unchanged
- [ ] `breakerKey(routeId, agentRole)` added alongside existing `breakerKey(provider, agentRole)`
- [ ] AI-005c collapse rule preserved (`effectiveAgentRole=null` when no `agent_configs` row)
### B1.7 — Dispatcher wiring (behind feature flag)
- [ ] `resolveAgentCall` in `backend/src/aiProvider/dispatcher.js` gains a `useRoutes` branch
- [ ] Flag: `process.env.AI_ROUTES_ENABLED === "true"` (default off)
- [ ] When on → `resolveRoute` + `protocolAdapter`
- [ ] When off → existing `resolveProvider` path unchanged
### B1.8 — Tests
- [ ] `backend/tests/provider-routes.test.js` — repo CRUD, cycle guard, JSON round-trip, audit log emission
- [ ] `backend/tests/secrets.test.js` — encrypt/decrypt round-trip, missing master key fails fast, lastFour extraction
- [ ] `backend/tests/protocol-adapter.test.js` — each protocol's `generate` + `stream` shape
- [ ] `backend/tests/resolve-route.test.js` — priority chain, AI-005c collapse, shim behavior
- [ ] `backend/tests/chaos-provider.test.js` — mock adapter: 500s, malformed JSON, partial stream, slow trickle, mid-stream abort → verify breaker + fallback + no leaks
- [ ] Register all in `backend/tests/run-tests.js`
### B1.9 — Docs
- [ ] `docs/changelog.md` under `## [Unreleased]` — additive note, flag off by default
- [ ] `docs/operations/secrets-rotation.md` — master key rotation playbook
- [ ] ROADMAP.md — add foundation entry
## Exit criteria
- [ ] All existing tests pass with `AI_ROUTES_ENABLED=false` (default)
- [ ] All existing tests pass with `AI_ROUTES_ENABLED=true` (shim path)
- [ ] Chaos tests pass
- [ ] Secrets never appear in logs, metrics, or API responses
- [ ] Zero operator-visible change
---
# Bundle 2 — Migration + capability probe + pricing + per-request log
**Scope:** Migrate `agent_configs.provider → routeId`. Auto-probe capabilities. Per-route pricing. Per-request audit log with PII redaction. Delete the feature flag.
**Risk:** Breaking migration. Requires backfill + dry-run.
**PR title:** `feat(ai-provider): routeId migration + capability probe + per-route pricing + request log`
## Tasks
### B2.1 — Migration `agent_configs.provider → routeId`
- [ ] Migration adds `agent_configs.routeId TEXT REFERENCES provider_routes(id)`
- [ ] Backfill script `backend/src/database/migrations/scripts/backfill-routes.js` with `--dry-run`:
  - For each `agent_configs` row, find-or-create a `provider_routes` row matching `{family: provider, protocol: <default>, model}`
  - Sets `routeId`
- [ ] Drop `agent_configs.provider`, `agent_configs.model` columns (keep `systemPromptOverride`, `temperature`, `maxTokens`, `fallbackRole` for one release)
- [ ] `agentConfigRepo.upsert` validates `routeId` exists in same workspace
- [ ] Rollback test: apply migration, downgrade, verify no data loss
### B2.2 — Capability auto-probe
- [ ] Auto-run on route `upsert`; persist to `provider_routes.capabilities`
- [ ] `POST /api/v1/settings/provider-routes/:id/probe` — admin re-probe endpoint
- [ ] Update `backend/src/middleware/permissions.json`
- [ ] Emits audit log entry (`action: "probe"`)
### B2.3 — Vision-heal reads from route
- [ ] `backend/src/aiProvider/vision.js` — replace `VISION_CAPABLE_MODELS` hardcoded set with `route.capabilities.vision` lookup
- [ ] `resolveVisionModel({ workspaceId })` reads the `healer` agent_config's `routeId` → route's `model` + `capabilities`
### B2.4 — Per-route pricing
- [ ] `recordAiTokens` in `backend/src/aiProvider/dispatcher.js` reads pricing from resolved route
- [ ] Emit `app_ai_cost_usd_total` only when `route.pricing != null` — never error on missing pricing
- [ ] Add `route_name` label to all 4 AI Prometheus metrics in `backend/src/utils/metrics.js`
- [ ] Keep `MODEL_PRICING` as UI-suggestion catalog only (loaded by Settings UI as defaults)
- [ ] OTel span attribute `ai.route_name` in `annotateAiCallSpan` (`backend/src/utils/observability.js`)
### B2.5 — Per-request log with PII redaction
- [ ] Migration `NNN_ai_request_log.sql`:
  ```sql
  CREATE TABLE ai_request_log (
    id TEXT PRIMARY KEY,
    workspaceId TEXT NOT NULL,
    routeId TEXT,
    agentRole TEXT,
    userId TEXT,
    promptHash TEXT NOT NULL,
    promptRedacted TEXT,
    responseRedacted TEXT,
    inputTokens INTEGER,
    outputTokens INTEGER,
    costUsd REAL,
    latencyMs INTEGER,
    outcome TEXT,                         -- success|error|rate_limited|cached
    errorReason TEXT,
    traceId TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX idx_req_log_workspace ON ai_request_log(workspaceId, createdAt);
  CREATE INDEX idx_req_log_trace ON ai_request_log(traceId);
  ```
- [ ] `backend/src/aiProvider/requestLog.js`:
  - `logRequest({ ...fields })` — async fire-and-forget, never blocks the call
  - PII redaction pipeline: regex for email, phone, credit card, SSN + workspace-supplied custom rules
  - Storage modes (per workspace): `none` (default, metadata only) | `redacted` | `full` (admin opt-in)
- [ ] Wire into `callProvider` post-call hook in `dispatcher.js`
- [ ] `GET /api/v1/settings/ai-requests` — admin, paginated, filter by `routeId` / `agentRole` / `traceId` / `outcome`
- [ ] `POST /api/v1/settings/ai-requests/:id/replay` — re-issue logged prompt against any route
- [ ] Retention: default 30 days, daily janitor, configurable per workspace
### B2.6 — Remove feature flag
- [ ] Delete `AI_ROUTES_ENABLED` branch from `resolveAgentCall`
- [ ] `resolveRoute` is now the only path
- [ ] Delete `resolveProvider` (or keep as thin wrapper returning `route.family` for legacy reads)
### B2.7 — Tests
- [ ] `backend/tests/capability-probe.test.js` — each capability dimension
- [ ] `backend/tests/migration-routeid.test.js` — backfill correctness, no orphan agent_configs
- [ ] `backend/tests/migration-rollback.test.js` — apply + downgrade + verify no data loss
- [ ] `backend/tests/request-log.test.js` — PII redaction, storage modes, replay
- [ ] Update `backend/tests/agent-dispatch.test.js` — assertions switch from `provider` to `routeId`
- [ ] Register all in `backend/tests/run-tests.js`
### B2.8 — Docs
- [ ] `docs/changelog.md` — breaking change notice, migration instructions
- [ ] Update `docs/guide/multi-agent-pipeline.md` — references routes, not providers
- [ ] `docs/operations/request-log.md` — storage modes, redaction rules, replay
## Exit criteria
- [ ] All `agent_configs` rows point at real `provider_routes` rows
- [ ] `MODEL_PRICING` no longer read at runtime (only by UI for defaults)
- [ ] Vision-heal works via `route.capabilities.vision`
- [ ] Every AI call produces a request log entry (mode-dependent storage)
- [ ] Replay endpoint works against arbitrary route
- [ ] Migration rollback test passes
---
# Bundle 3 — Operator surface + quotas + caching
**Scope:** Settings UI for routes. JSON import/export. Compat-slot migration. Per-route fallback UI. Rate limits + spend caps. Response caching (exact-match). Key rotation workflow.
**Risk:** User-visible. Compat slots auto-migrate. Hot-path additions (quota + cache) gated per-route.
**PR title:** `feat(ai-provider): operator surface — Settings UI, import/export, quotas, cache, key rotation`
## Tasks
### B3.1 — Settings UI — Provider Routes tab
- [ ] New `ProviderRoutesTab` in `frontend/src/pages/Settings.jsx` (mirror `AgentRolesTab` pattern)
- [ ] Per-row: name, family, protocol, baseUrl, model, apiKey (write-only, shows `••••<lastFour>`), fallbackRoute, enabled toggle, rpmLimit, tpmLimit, cacheEnabled, cacheTtlSec
- [ ] **Test** button → `POST /api/v1/settings/provider-routes/:id/probe` with inline green/red badge
- [ ] **Re-probe** button on saved routes
- [ ] **Rotate key** button (B3.6)
- [ ] CSS in `frontend/src/styles/pages/settings.css` (no inline styles)
### B3.2 — Per-route fallback UI
- [ ] Fallback dropdown lists other routes in same workspace
- [ ] Frontend cycle preview: warn before save (backend authoritative via `ERR_ROUTE_FALLBACK_CYCLE`)
- [ ] Deprecate `agent_configs.fallbackRole` UI surface — route-level fallback is canonical (keep DB column for one release for rollback)
### B3.3 — Settings API routes
- [ ] `GET /api/v1/settings/provider-routes` — list
- [ ] `POST /api/v1/settings/provider-routes` — create
- [ ] `PUT /api/v1/settings/provider-routes/:id` — update
- [ ] `DELETE /api/v1/settings/provider-routes/:id` — refuses if any `agent_configs.routeId` references it
- [ ] All admin-gated via `requireRole("admin")`
- [ ] Update `backend/src/middleware/permissions.json` for all routes
### B3.4 — Frontend `api.js` helpers
- [ ] `api.listRoutes()`, `api.createRoute(body)`, `api.updateRoute(id, body)`, `api.deleteRoute(id)`, `api.probeRoute(id)`, `api.rotateKey(id, newKey)`
- [ ] JSDoc on each matching the `testAgentRole` pattern
### B3.5 — JSON import/export with schema versioning
- [ ] `GET /api/v1/settings/provider-routes/export`:
  - Returns `{ schemaVersion: 1, routes: [...] }`
  - Redacts encrypted secrets entirely (export references only)
  - Emits audit log entry (`action: "export"`)
- [ ] `POST /api/v1/settings/provider-routes/import`:
  - Body: `{ schemaVersion, routes, mode: "skip" | "overwrite" | "rename" }`
  - `skip` — existing names untouched
  - `overwrite` — replace by name (preserves keys if not in payload)
  - `rename` — append `-2`, `-3` on collision
  - Validates schema version; forward-compat shim for older versions
  - Re-runs capability probe on each imported route (bounded parallel)
  - Emits audit log entry (`action: "import"`)
- [ ] Schema published as JSON Schema with `$id` for external tooling under `docs/schema/provider-routes-v1.json`
- [ ] Frontend buttons in Provider Routes tab — file download / file upload with mode selector
- [ ] `api.exportRoutes()`, `api.importRoutes(file, mode)`
### B3.6 — Key rotation workflow
- [ ] `POST /api/v1/settings/provider-routes/:id/rotate-key`:
  - Body: `{ newApiKey }`
  - Encrypts new key, swaps atomically in a transaction
  - Runs capability probe with new key before commit; rejects on probe fail
  - Clears all `(routeId, *)` circuit breakers
  - Emits audit log entry (`action: "rotate_key"`)
- [ ] Frontend **Rotate key** button on each route row
- [ ] Plaintext cache in `secrets.js` invalidated for the rotated route
### B3.7 — Rate limits + spend caps
- [ ] Schema additions to `workspaces`:
  - `dailySpendCapUsd REAL`
  - `monthlySpendCapUsd REAL`
  - `spendAlertThresholdPct INTEGER DEFAULT 80`
- [ ] `backend/src/aiProvider/quotaGuard.js`:
  - Token-bucket rate limiter — in-memory single-node; Redis-backed multi-node (env-gated via `REDIS_URL`)
  - `checkAndReserve(routeId, estimatedTokens) → { ok, retryAfterMs }`
  - `reportActual(routeId, actualTokens, costUsd)` post-call
  - `checkSpendCap(workspaceId) → { ok, remainingUsd }` (queries `app_ai_cost_usd_total` by workspace)
- [ ] Wire into `callProvider`:
  - Pre-call: `checkAndReserve` + `checkSpendCap`
  - Reject with `ERR_RATE_LIMIT_LOCAL` / `ERR_SPEND_CAP_EXCEEDED` (don't burn an API call)
  - Post-call: `reportActual`
- [ ] Spend alert: when `currentSpend >= cap * alertThresholdPct/100`, emit notification (Slack/webhook if configured) + log event
- [ ] Settings UI: **Rate limits** (per route) + **Spend caps** (per workspace)

### B3.8 — Response caching (exact-match)
- [ ] Migration `NNN_ai_response_cache.sql`:
  ```sql
  CREATE TABLE ai_response_cache (
    cacheKey TEXT PRIMARY KEY,
    routeId TEXT NOT NULL,
    response TEXT NOT NULL,
    usage TEXT,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    hitCount INTEGER DEFAULT 0
  );
  CREATE INDEX idx_cache_expires ON ai_response_cache(expiresAt);
  ```
- [ ] `backend/src/aiProvider/responseCache.js`:
  - `getCached(routeId, promptOrMessages, opts) → { response, usage } | null`
  - `setCached(routeId, promptOrMessages, opts, response, usage, ttlSec)`
  - Cache key: `sha256(routeId + model + stableJSON({ messages, maxTokens, temperature, responseFormat }))`
  - Never cache streaming calls (skip silently)
  - Periodic janitor: `DELETE WHERE expiresAt < now()` every 10 min
- [ ] Per-route opt-in via `provider_routes.cacheEnabled` + `cacheTtlSec`
- [ ] Per-call opt-out: `generateText(prompt, { skipCache: true })` — used by self-healing where staleness is dangerous
- [ ] Metrics: `app_ai_cache_hits_total{routeId,agent_role}`, `app_ai_cache_misses_total`, `app_ai_cache_savings_usd_total`
- [ ] Wire into `callProvider`: check cache pre-call (when enabled), populate post-call
- [ ] Thundering herd protection: in-flight request coalescing keyed by `cacheKey`
- [ ] **Semantic (embedding-based) cache deferred** — exact-match covers the high-value cases
### B3.9 — Audit log viewer
- [ ] `GET /api/v1/settings/provider-routes/audit` — admin, paginated, filterable by `routeId` / `action` / date range
- [ ] Frontend: **Audit log** subtab in Settings → Provider Routes
- [ ] Retention: 90 days default, configurable via `AI_ROUTES_AUDIT_RETENTION_DAYS`, daily janitor
### B3.10 — Compat slot migration
- [ ] One-shot migration `NNN_compat_to_routes.sql`:
  - Every `compat:<id>` config row → new `provider_routes` row with `protocol: "openai"`, `family: "custom"`
  - Preserves `name`, `baseUrl`, `model`; migrates plaintext key into encrypted columns
  - Emits audit log entry (`action: "create"`) tagged with migration source
- [ ] Remove `compat:<id>` special-case branches in `backend/src/aiProvider/registry.js` and `dispatcher.js`
- [ ] Thin-wrap `isCompatProvider` / `getCompatConfig` / `listCompatSlots` to query `provider_routes WHERE family = "custom"` (or delete if no callers remain)
- [ ] Update operator-facing references in Settings UI — compat slots are just routes
### B3.11 — Tests
- [ ] `backend/tests/provider-routes-api.test.js` — CRUD + probe + rotate-key endpoints, admin gating
- [ ] `backend/tests/routes-import-export.test.js` — round-trip, mode semantics, secret redaction, schema version validation, forward-compat shim
- [ ] `backend/tests/compat-migration.test.js` — every compat slot becomes a route, dispatch still works, keys re-encrypted
- [ ] `backend/tests/quota-guard.test.js` — token-bucket correctness, spend cap enforcement, concurrent reserve/release
- [ ] `backend/tests/response-cache.test.js` — exact-match hit, TTL expiry, streaming skip, thundering herd coalescing, `skipCache` opt-out
- [ ] `backend/tests/concurrent-dispatch.test.js` — 100 parallel calls: no breaker race, no quota overflow, cache populates exactly once
- [ ] Frontend: extend Settings page tests to cover the new tab + import/export flow
- [ ] Register all in `backend/tests/run-tests.js`
### B3.12 — Docs
- [ ] New guide `docs/guide/provider-routes.md` — operator walkthrough: add a vendor end-to-end with zero code edits
- [ ] Update `docs/guide/multi-agent-pipeline.md` — Agent Roles reference routes by name
- [ ] `docs/operations/quotas-and-caching.md` — rate limit + spend cap + cache tuning
- [ ] `docs/changelog.md` — operator-visible additions
- [ ] ROADMAP.md — Completed Work Summary entries
- [ ] QA.md — walk the new Settings flow
## Exit criteria
- [ ] Operator adds a vendor end-to-end via UI with zero code edits
- [ ] Existing compat slots auto-migrate, dispatch unchanged
- [ ] Export/import round-trips (minus secrets) and validates schema version
- [ ] Per-route fallback chain configurable + cycle-protected
- [ ] Rate limits reject excess calls without burning provider quota
- [ ] Spend caps hard-stop at limit; alerts fire at threshold
- [ ] Cache hits visible in metrics; semantic deferred
- [ ] Audit log captures every mutation
- [ ] Key rotation atomic + probe-gated
- [ ] All tests pass
---
# Bundle 4 — Cleanup, hardening sweep, advanced routing (deferred)
**Scope:** Hardcoded-family-string sweep. Dashboard label updates. E2E contract test. Load test. Drop deprecated columns. Advanced routing primitives (gated behind operator demand).
**Risk:** Low. Mostly cleanup. Advanced routing is opt-in.
**PR title:** `chore(ai-provider): cleanup + load tests + advanced routing primitives`
> **Defer trigger:** Don't build B4.6 (advanced routing) until ≥1 operator requests weighted/cost-aware routing. YAGNI risk is real.
## Tasks
### B4.1 — Remove single-model-per-family assumptions
- [ ] Grep audit:
  ```
  grep -rn '"anthropic"\|"openai"\|"google"\|"ollama"' backend/src/
  ```
- [ ] Replace each call-site with route lookup:
  - `getDefaultRouteForFamily(workspaceId, family)` for legacy paths
  - Direct `routeId` for new paths
- [ ] Known sites:
  - `backend/src/aiProvider/vision.js`
  - `backend/src/aiProvider/providerInfo.js`
  - `backend/src/aiProvider/registry.js` env-detection branches
  - `backend/src/selfHealing.js`
### B4.2 — Observability parity
- [ ] Verify `route_name` label populates on all AI metrics in Grafana
- [ ] Update operator dashboards (if checked into repo) to split by `route_name` instead of `provider`
- [ ] Document cardinality budget: routes are workspace-scoped, capped per workspace
- [ ] Update alert rules that key on `provider` label
- [ ] Add cache + quota dashboard panel: hit ratio, cache savings $, rate-limit rejections, spend cap utilization
### B4.3 — Drop deprecated columns
- [ ] Migration to drop `agent_configs.fallbackRole` (deprecated in B3.2)
- [ ] Migration to drop any legacy `compat:<id>` tables (data already migrated in B3.10)
- [ ] Only run after Bundle 3 has been in production ≥1 release without rollback
### B4.4 — End-to-end contract tests
- [ ] `backend/tests/provider-routes-pipeline.test.js`:
  - Seed 2 Anthropic routes (different models) in one workspace
  - Assign route A to `planner`, route B to `author`
  - Run fake pipeline call for each role
  - Assert both routes get hits via `app_ai_provider_tokens_total` split by `route_name`
- [ ] `backend/tests/no-code-edits-contract.test.js`:
  - Register a route with made-up name + protocol-compatible URL (mock HTTP layer)
  - Verify dispatch reaches the mock without any code changes
  - Pins the "no code edits to add a vendor" contract
- [ ] `backend/tests/secrets-rotation-e2e.test.js`:
  - Create route → encrypt key → rotate → probe → dispatch → verify old key fails, new key works
  - Asserts master key rotation procedure documented in B1.4
### B4.5 — Load tests (manual / nightly, not in unit run)
- [ ] `backend/tests/load/dispatch-overhead.js`:
  - N=10 routes × M=7 roles × 1000 calls each (mocked HTTP)
  - Asserts: `resolveRoute` + `quotaGuard.checkAndReserve` + `responseCache.getCached` p99 < 5ms combined
  - Output: histogram per stage
- [ ] `backend/tests/load/cache-throughput.js`:
  - 10k cache reads, 1k writes/sec
  - Asserts: SQLite cache layer doesn't bottleneck
- [ ] CI: nightly run via separate workflow; not blocking PRs
### B4.6 — Advanced routing primitives (gated, build only when requested)
- [ ] **Route groups**: schema for `route_groups(id, workspaceId, name, strategy)` where `strategy ∈ {weighted, latency, cost}`
- [ ] **Weighted routing**: `route_group_members(groupId, routeId, weight)` — random pick by weight
- [ ] **Latency-based routing**: pick the lowest-p50 healthy route from the group
- [ ] **Cost-aware routing**: pick cheapest route in the group meeting capability requirements (`vision`, `jsonMode`, etc.)
- [ ] `agent_configs.routeId` can point at a group_id; `resolveRoute` resolves group → concrete route at call time
- [ ] Settings UI: **Route Groups** subtab
- [ ] Decision matrix doc: when to use groups vs single routes vs role-level fallback
- [ ] **Skip if no operator demand**
### B4.7 — Documentation polish
- [ ] `docs/guide/provider-routes.md` — add troubleshooting table (mirror `multi-agent-pipeline.md`)
- [ ] `docs/guide/multi-agent-pipeline.md` — final sweep for any "provider" → "route" terminology drift
- [ ] `README.md` — update AI provider section
- [ ] ROADMAP.md — final Completed Work Summary entries
- [ ] NEXT.md — Recently Completed + Remaining count
- [ ] If B4.6 shipped: `docs/guide/advanced-routing.md`
## Exit criteria
- [ ] Zero hardcoded family strings in dispatch path
- [ ] Dashboards split by `route_name`; cache + quota panels live
- [ ] E2E tests pin multi-route + no-code-edits + key-rotation contracts
- [ ] Load tests pass p99 budget
- [ ] All docs reference routes consistently
- [ ] (Optional) Advanced routing shipped if operators asked
---
# Cross-bundle invariants 
These must hold across every bundle — verify before merging each PR.
- [ ] AI-005c single-agent collapse rule preserved (no wasted-call amplification on free-tier providers)
- [ ] Per-`(route, role)` circuit breaker isolation — a rate-limited planner does not trip the author's breaker
- [ ] `agent_role` Prometheus label remains bounded (canonical 7 roles + `"default"`)
- [ ] OTel span attribution stays in sync with Prometheus labels (both carry `route_name` + `agent_role`)
- [ ] Pre-flight `assertAgentConfigsHealthy` still runs before any pipeline kickoff
- [ ] `fallbackRouteId` cycle protection enforced at save time (`ERR_ROUTE_FALLBACK_CYCLE`)
- [ ] **Secrets never appear in logs, metrics, API responses, or exports** — only `apiKeyLastFour` is operator-visible
- [ ] **Audit log entry on every mutation** (create, update, delete, rotate_key, probe, export, import)
- [ ] **Quota guard never burns provider quota** — local reject before HTTP call
- [ ] **Cache never serves stale data to self-healing** — `skipCache: true` honored
- [ ] All new endpoints in `permissions.json` with correct `requireRole()` gate
- [ ] All new tests registered in `backend/tests/run-tests.js`
- [ ] `docs/changelog.md` updated under `## [Unreleased]` for user-visible changes
---
# Risk register
| Risk | Mitigation | Bundle |
|---|---|---|
| Bundle 2 migration breaks live workspaces | `--dry-run` backfill + keep deprecated columns one release + rollback test | B2.1 |
| Feature flag drift between B1 (off) and B2 (removed) | B2.6 deletes flag in same PR as migration | B2.6 |
| Compat slot users lose access during migration | Auto-migrate in same PR as Routes UI launch | B3.10 |
| `MODEL_PRICING` removal loses cost data for unconfigured routes | B2.4 keeps it as UI default catalog; routes without pricing skip cost metric (don't error) | B2.4 |
| Generic adapter regresses vs existing family adapters | B1.7 feature flag enables A/B on canary workspace before B2.6 deletes old path | B1.7 |
| Route name collisions on JSON import | B3.5 import modes (`skip` / `overwrite` / `rename`) | B3.5 |
| Hardcoded provider strings missed in B4.1 sweep | B4.4 E2E test forces dispatch through routes — any missed site fails the test | B4.4 |
| **Master key loss = unrecoverable secrets** | B1.4 rotation playbook + B1.9 docs require backup before deploy | B1.4 |
| **Quota false positives reject legitimate calls** | B3.7 token-bucket includes burst capacity; metrics expose rejection rate for tuning | B3.7 |
| **Cache serves stale response to safety-critical path** | B3.8 `skipCache` opt-out + self-healing call sites set it explicitly | B3.8 |
| **Audit log growth unbounded** | B3.9 retention janitor (90 days default) | B3.9 |
| **Redis dependency for multi-node quota guard** | B3.7 env-gated via `REDIS_URL`; falls back to in-memory single-node | B3.7 |
| **PII leaks through full-mode request log** | B2.5 redaction pipeline + admin opt-in + compliance acknowledgement required | B2.5 |
| **Schema version drift between import/export tooling** | B3.5 publishes JSON Schema with `$id`; forward-compat shim for older versions | B3.5 |
| **Load test never run pre-prod** | B4.5 nightly CI workflow; gating on PR if budget regresses | B4.5 |
---
# Bundle ordering rationale
| Bundle | Why it ships when it does |
|---|---|
| **1** | Pure additive. Schema + adapter + resolution + encrypted secrets land together because they share the schema migration and audit log scaffolding. Feature flag means zero blast radius. |
| **2** | The risky migration (`provider → routeId`). Bundled with capability probe + pricing + request log because they all mutate the same hot path (`callProvider`). Flag deletion happens here so post-bundle there's one resolution path, not two. |
| **3** | Operator surface lights up only after foundation + migration are battle-tested. Bundles UI + quotas + cache + import/export + compat migration because they share the same Settings page surface area and the same admin API gating. |
| **4** | Cleanup + load tests + optional advanced routing. Safely deferrable. Advanced routing is YAGNI-gated. |
---
# Estimated effort (rough)
| Bundle | Tasks | Est. agent-days | Critical path |
|---|---|---|---|
| 1 | 9 task groups, ~25 files | 4–6 | Encrypted secrets + protocol adapter |
| 2 | 8 task groups, ~20 files | 5–7 | Migration backfill + rollback test |
| 3 | 12 task groups, ~30 files | 7–10 | Settings UI + import/export + quota guard |
| 4 | 7 task groups, ~15 files | 3–5 (skip B4.6 unless requested) | Hardcoded-string sweep + load tests |
| **Total** | **36 task groups, ~90 files** | **19–28 agent-days** | — |
> Effort assumes single agent working linearly. Bundles 1 and 2 can't parallelize (B2 depends on B1's schema). Bundle 3 subtasks can parallelize within the bundle once B2 lands. Bundle 4 fully parallelizable.
---
# Definition of done (whole roadmap)
Operator can:
1. ✅ Add a new vendor in the Settings UI by entering `{name, url, model, apiKey}` — zero code edits
2. ✅ Run N routes per family (e.g. 3 Anthropic routes with different models)
3. ✅ Configure independent fallback per route with cycle protection
4. ✅ See auto-probed capabilities (vision, JSON mode, tools, streaming, max context)
5. ✅ Set optional per-route pricing; cost metric emits only when set
6. ✅ Export/import all routes as JSON (secrets redacted, schema versioned)
7. ✅ Rotate keys without recreating the route; audit log captures it
8. ✅ Set per-route RPM/TPM limits and per-workspace spend caps with alerts
9. ✅ Enable response caching per route with TTL; see hit ratio + savings in metrics
10. ✅ View per-request audit log with PII-redacted prompts; replay any logged request
11. ✅ Trust that secrets are encrypted at rest with documented key rotation
12. ✅ Trust that every mutation is auditable with 90-day retention
System guarantees:
- ✅ Multi-agent dispatch (AI-005) preserved end-to-end
- ✅ AI-005c single-agent collapse preserved (no wasted calls on free tier)
- ✅ Per-`(route, role)` breaker isolation
- ✅ Sub-5ms p99 dispatch overhead (load test verified)
- ✅ Zero hardcoded family strings in dispatch path
- ✅ Chaos tests pass: 500s, malformed JSON, partial streams, slow trickles, mid-stream aborts
- ✅ Migration rollback works without data loss
- ✅ No secrets in logs, metrics, exports, or API responses
---
# Out of scope (explicit non-goals)
These are intentionally NOT in this roadmap. Document the decision so future contributors don't add them without discussion.
- ❌ **Semantic (embedding-based) cache** — exact-match covers high-value cases; embedding cost + complexity not justified pre-scale
- ❌ **Multi-region failover / EU data residency** — defer until enterprise customer asks
- ❌ **Per-user / per-team cost attribution beyond workspace** — workspace-level sufficient for current product stage
- ❌ **Showback / chargeback billing reports** — metrics are exposed via Prometheus; downstream tooling can build reports
- ❌ **BYO-KMS for enterprise** — defer until enterprise customer asks; current AES-256-GCM with master key from env is sufficient
- ❌ **Streaming response caching** — cardinality blowup; not worth complexity
- ❌ **DAG agent handshake** (`{fromRole, toRole, artifact, traceId}`) — separate work item (AUTO-023)
- ❌ **Per-`(workspace, role)` API keys distinct from per-route keys** — separate work item (AI-005b)
```
