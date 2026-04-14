# Projects API

## Create a Project

```
POST /api/projects
```

**Body:**
```json
{
  "name": "My App",
  "url": "https://example.com",
  "credentials": {                // optional
    "username": "admin",
    "password": "secret"
  }
}
```

## List Projects

```
GET /api/projects
```

Returns an array of all non-deleted projects.

## Get a Project

```
GET /api/projects/:id
```

## Delete a Project

```
DELETE /api/projects/:id
```

Soft-deletes the project and cascade soft-deletes all its tests and runs. Items are moved to the Recycle Bin and can be restored via `POST /api/restore/project/:id`. Healing history and activities are preserved for audit trail. Returns 409 if a crawl or test run is in progress.

## Start a Crawl

```
POST /api/projects/:id/crawl
```

Launches Chromium, crawls the project URL, and generates tests via the AI pipeline. Returns a run ID for tracking via SSE.

**Body (optional):**
```json
{
  "maxDepth": 3,
  "dialsConfig": { ... }
}
```

## Run Regression

```
POST /api/projects/:id/run
```

Executes all approved tests for the project. Returns a run ID.

## CI/CD Trigger

```
POST /api/projects/:id/trigger
```

**Auth:** `Authorization: Bearer <project-trigger-token>` (not a user JWT).

Token-authenticated endpoint for CI/CD pipelines. Starts a test run using the project's approved tests and returns immediately.

**Body (optional):**
```json
{
  "dialsConfig": { "parallelWorkers": 2 },
  "callbackUrl": "https://ci.example.com/hooks/sentri"
}
```

**Response `202 Accepted`:**
```json
{ "runId": "RUN-42", "statusUrl": "https://sentri.example.com/api/runs/RUN-42" }
```

Poll `statusUrl` until `status` is no longer `"running"`. If `callbackUrl` is provided, Sentri POSTs a summary when the run finishes (best-effort, 10s timeout).

| Error | Reason |
|---|---|
| 400 | No approved tests |
| 401 | Missing or invalid Bearer token |
| 403 | Token belongs to a different project |
| 404 | Project not found |
| 409 | Another run already in progress |
| 429 | Rate limit exceeded |

## List Trigger Tokens

```
GET /api/projects/:id/trigger-tokens
```

Returns all trigger tokens for the project (token hashes are never returned).

**Response:**
```json
[
  { "id": "WH-1", "label": "GitHub Actions", "createdAt": "...", "lastUsedAt": "..." }
]
```

## Create Trigger Token

```
POST /api/projects/:id/trigger-tokens
```

**Body (optional):**
```json
{ "label": "GitHub Actions" }
```

**Response `201`:**
```json
{ "id": "WH-1", "token": "<plaintext — shown once>", "label": "GitHub Actions", "createdAt": "..." }
```

::: warning
The plaintext token is returned **exactly once**. Store it securely (e.g. as a CI secret). It cannot be retrieved again.
:::

## Revoke Trigger Token

```
DELETE /api/projects/:id/trigger-tokens/:tid
```

Permanently deletes the token. CI pipelines using it will fail immediately.
