# Runs API

## List Runs for a Project

```
GET /api/projects/:id/runs
```

Returns runs sorted newest-first.

## Get Run Detail

```
GET /api/runs/:runId
```

Includes per-test results, screenshots, timing, and failure classification.

## SSE Event Stream

```
GET /api/runs/:runId/events
```

Server-Sent Events stream. Stays open while the run is in progress. Event types:

| Event | Data |
|---|---|
| `log` | `{ message, level, timestamp }` |
| `result` | `{ testId, testName, status, duration, error?, screenshot? }` |
| `frame` | `{ data }` — base64 JPEG from CDP screencast |
| `done` | `{ status, passed, failed, total, duration }` |

### Client Example

```js
const es = new EventSource('/api/runs/RUN-1/events');
es.addEventListener('log', (e) => console.log(JSON.parse(e.data)));
es.addEventListener('result', (e) => console.log(JSON.parse(e.data)));
es.addEventListener('done', (e) => { console.log(JSON.parse(e.data)); es.close(); });
```

## Abort a Run

```
POST /api/runs/:runId/abort
```

Sends `AbortSignal` through the entire pipeline — AI calls, browser operations, and feedback loops halt immediately.
