# Settings API

## Get Active Provider Config

```
GET /api/config
```

Returns the currently active AI provider info:

```json
{
  "hasProvider": true,
  "providerName": "Anthropic Claude",
  "model": "claude-sonnet-4-20250514",
  "color": "#e8965a"
}
```

## Get Provider Key Status

```
GET /api/settings
```

Returns masked keys and active provider (never returns full keys):

```json
{
  "activeProvider": "anthropic",
  "anthropic": "sk-ant-***...***03",
  "openai": null,
  "google": null,
  "ollamaBaseUrl": "http://localhost:11434",
  "ollamaModel": "mistral:7b"
}
```

## Set an API Key

```
POST /api/settings
```

**Cloud provider:**
```json
{ "provider": "anthropic", "apiKey": "sk-ant-api03-..." }
```

**Ollama (local):**
```json
{ "provider": "local", "baseUrl": "http://localhost:11434", "model": "mistral:7b" }
```

## Remove a Provider Key

```
DELETE /api/settings/:provider
```

## Check Ollama Status

```
GET /api/ollama/status
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
GET /api/system
```

## Dashboard Analytics

```
GET /api/dashboard
```

## Data Management

| Method | Endpoint | Description |
|---|---|---|
| `DELETE` | `/api/data/runs` | Permanently clear all run history |
| `DELETE` | `/api/data/activities` | Clear activity log |
| `DELETE` | `/api/data/healing` | Clear self-healing history |

## Recycle Bin

Deleted projects, tests, and runs are soft-deleted (moved to the Recycle Bin) rather than permanently removed. Use these endpoints to browse, restore, or permanently purge deleted items.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/recycle-bin` | List all soft-deleted entities grouped by type |
| `POST` | `/api/restore/:type/:id` | Restore a soft-deleted entity (`type`: `project`, `test`, or `run`) |
| `DELETE` | `/api/purge/:type/:id` | Permanently delete a soft-deleted entity |

**Restore behavior:**
- Restoring a **project** cascade-restores its tests and runs that were deleted at the same time. Items individually deleted before the project are left in the recycle bin.
- Restoring a **test** or **run** whose parent project is deleted returns `409` — restore the project first.

**Note:** The recycle bin endpoint returns all soft-deleted items (capped at 200 per type) without pagination. For paginated listing of live entities, see the [Tests](/api/tests) and [Runs](/api/runs) API docs.
