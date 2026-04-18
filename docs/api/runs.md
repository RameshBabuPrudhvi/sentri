# Runs API

> All run endpoints are under `/api/v1/` (INF-005). Legacy `/api/*` paths are 301-redirected.

## Start a Crawl + Generate Run

```
POST /api/v1/projects/:id/crawl
```

**Body (optional):**
```json
{ "dialsConfig": { "exploreMode": "state", "parallelWorkers": 4, ... } }
```

Starts the 8-stage AI pipeline: crawl → filter → classify → plan → generate → deduplicate → enhance → validate. Returns immediately with a `runId` — track progress via SSE.

## Execute All Approved Tests

```
POST /api/v1/projects/:id/run
```

**Body (optional):**
```json
{ "dialsConfig": { "parallelWorkers": 4 } }
```

Runs all approved tests for the project. When `parallelWorkers > 1`, tests execute concurrently in isolated browser contexts within a single Chromium instance (1–10, default 1).

**Response:**
```json
{ "runId": "RUN-42" }
```

The run record includes `parallelWorkers` so the frontend and logs can show which concurrency level was used.

## List Runs for a Project

```
GET /api/v1/projects/:id/runs
```

Returns non-deleted runs sorted newest-first. Supports optional pagination:

```
GET /api/v1/projects/:id/runs?page=1&pageSize=10
```

When `page` or `pageSize` is provided, the response shape changes to `{ data: [], meta: { total, page, pageSize, hasMore } }`. Without pagination params, returns a flat array (backward-compatible). Default `pageSize` is 10 (max 200).

## Get Run Detail

```
GET /api/v1/runs/:runId
```

Includes per-test results, screenshots, timing, and failure classification.

## SSE Event Stream

```
GET /api/v1/runs/:runId/events
```

Server-Sent Events stream. Stays open while the run is in progress. Event types:

| Event | Data |
|---|---|
| `log` | `{ message, level, timestamp }` |
| `result` | `{ testId, testName, status, duration, error?, screenshot? }` |
| `snapshot` | `{ run }` — full run state (emitted after each test result for real-time progress, especially during parallel execution) |
| `frame` | `{ data }` — base64 JPEG from CDP screencast |
| `done` | `{ status, passed, failed, total, duration }` |

### Client Example

```js
const es = new EventSource('/api/v1/runs/RUN-1/events');
es.addEventListener('log', (e) => console.log(JSON.parse(e.data)));
es.addEventListener('result', (e) => console.log(JSON.parse(e.data)));
es.addEventListener('done', (e) => { console.log(JSON.parse(e.data)); es.close(); });
```

## Abort a Run

```
POST /api/v1/runs/:runId/abort
```

Sends `AbortSignal` through the entire pipeline — AI calls, browser operations, and feedback loops halt immediately.
