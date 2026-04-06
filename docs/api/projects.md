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

Deletes the project and **all** its tests, runs, and healing history.

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
