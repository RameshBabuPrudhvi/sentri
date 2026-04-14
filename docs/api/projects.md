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

Returns an array of all projects.

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
