# Settings API

> All settings endpoints are under `/api/v1/` (INF-005). Legacy `/api/*` paths are 308-redirected.

## Get Active Provider Config

```
GET /api/v1/config
```

Returns the currently active AI provider info:

```json
{
  "hasProvider": true,
  "providerName": "Anthropic Claude",
  "model": "claude-sonnet-4-20250514",
  "color": "#e8965a",
  "supportedProviders": ["anthropic", "openai", "google", "openrouter", "local"],
  "demoMode": false,
  "demoQuota": null
}
```

When `DEMO_GOOGLE_API_KEY` is set, `demoMode` is `true` and `demoQuota` contains per-user daily usage for authenticated users:

```json
{
  "demoMode": true,
  "demoQuota": {
    "crawl": { "used": 1, "limit": 2, "remaining": 1 },
    "run": { "used": 0, "limit": 3, "remaining": 3 },
    "generation": { "used": 2, "limit": 5, "remaining": 3 }
  }
}
```

## Get Provider Key Status

```
GET /api/v1/settings
```

Returns masked keys and active provider (never returns full keys):

```json
{
  "activeProvider": "anthropic",
  "anthropic": "sk-ant-***...***03",
  "openai": null,
  "google": null,
  "openrouter": null,
  "ollamaBaseUrl": "http://localhost:11434",
  "ollamaModel": "mistral:7b",
  "ollamaConfigured": false,
  "compatProviders": [
    {
      "provider": "compat:deepseek",
      "displayName": "DeepSeek",
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "apiKey": "sk-dee***...***f9c"
    }
  ]
}
```

`compatProviders` (AI-001) lists every configured OpenAI-compatible slot keyed `compat:<id>`. `apiKey` values are always masked; the unmasked key never leaves the backend.

## Set an API Key

```
POST /api/v1/settings
```

**Cloud provider:**
```json
{ "provider": "anthropic", "apiKey": "sk-ant-api03-..." }
```

**Ollama (local):**
```json
{ "provider": "local", "baseUrl": "http://localhost:11434", "model": "mistral:7b" }
```

**OpenAI-compatible slot (AI-001):**
```json
{
  "provider": "compat:deepseek",
  "displayName": "DeepSeek",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKey": "sk-..."
}
```

| Field | Required | Validation |
|---|---|---|
| `provider` | Yes | Must match `^compat:[a-z0-9_-]+$`. The portion after `compat:` is the slot id; it must be non-empty and match the regex. |
| `baseUrl` | Yes | HTTPS public URL by default. SSRF-validated server-side via `validateUrl()` — loopback / RFC1918 / link-local / `localhost` are rejected unless `ALLOW_PRIVATE_URLS=true` is set (intended for self-hosted vLLM / LiteLLM / LocalAI / internal proxies). |
| `model` | Yes | Vendor-specific model id (e.g. `deepseek-chat`, `llama-3.3-70b-versatile`). |
| `apiKey` | Yes | ≥ 10 characters. Stored AES-encrypted in the `api_keys` table. |
| `displayName` | No | Free-form label shown in the provider badge / dropdown. Defaults to the slot id. |

The slot is activated immediately and joins the FEA-003 fallback chain. Each slot has its own circuit breaker keyed by the full `compat:<id>` provider id. See [AI Providers → OpenAI-Compatible Providers](/guide/ai-providers#using-openai-compatible-providers-deepseek-groq-mistral-vllm) for a full vendor table.

**Quick-switch (no key change):**
```json
{ "provider": "compat:deepseek", "apiKey": "__use_existing__" }
```

Activates a slot that already has saved credentials without re-entering the key. Returns `400` if no saved row exists for the provider.

## Remove a Provider Key

```
DELETE /api/v1/settings/:provider
```

`provider` accepts any of the static ids (`anthropic`, `openai`, `google`, `openrouter`, `local`) **or** a compat slot id (`compat:<id>`, validated against `^[a-z0-9_-]+$`). Deleting a compat slot also resets its circuit breaker and clears any sticky-fallback pin pointing at it.

## Check Ollama Status

```
GET /api/v1/ollama/status
```

Returns connectivity status and available models:

```json
{
  "ok": true,
  "model": "mistral:7b:latest",
  "availableModels": ["mistral:7b:latest", "mistral:latest"]
}
```

## System Info

```
GET /api/v1/system
```

## Dashboard Analytics

```
GET /api/v1/dashboard
```

Returns project and test suite analytics. The response includes a `testsByUrl` object (DIF-011) mapping each source URL to the count of approved tests targeting it — used by the frontend coverage heatmap on the site graph:

```json
{
  "totalProjects": 3,
  "totalTests": 42,
  "testsByUrl": {
    "https://example.com/": 5,
    "https://example.com/login": 3,
    "https://example.com/dashboard": 1
  }
}
```

## Data Management

| Method | Endpoint | Description |
|---|---|---|
| `DELETE` | `/api/v1/data/runs` | Permanently clear all run history |
| `DELETE` | `/api/v1/data/activities` | Clear activity log |
| `DELETE` | `/api/v1/data/healing` | Clear self-healing history |

## Recycle Bin

Deleted projects, tests, and runs are soft-deleted (moved to the Recycle Bin) rather than permanently removed. Use these endpoints to browse, restore, or permanently purge deleted items.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/recycle-bin` | List all soft-deleted entities grouped by type |
| `POST` | `/api/v1/restore/:type/:id` | Restore a soft-deleted entity (`type`: `project`, `test`, or `run`) |
| `DELETE` | `/api/v1/purge/:type/:id` | Permanently delete a soft-deleted entity |

**Restore behavior:**
- Restoring a **project** cascade-restores its tests and runs that were deleted at the same time. Items individually deleted before the project are left in the recycle bin.
- Restoring a **test** or **run** whose parent project is deleted returns `409` — restore the project first.

**Note:** The recycle bin endpoint returns all soft-deleted items (capped at 200 per type) without pagination. For paginated listing of live entities, see the [Tests](/api/tests) and [Runs](/api/runs) API docs.
