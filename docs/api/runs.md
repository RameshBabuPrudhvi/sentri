# Runs API

> All run endpoints are under `/api/v1/` (INF-005). Legacy `/api/*` paths are 308-redirected.

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
{
  "dialsConfig": { "parallelWorkers": 4 },
  "browser": "firefox",
  "device": "iPhone 14",
  "locale": "fr-FR",
  "timezoneId": "Europe/Paris"
}
```

Runs all approved tests for the project. When `parallelWorkers > 1`, tests execute concurrently in isolated browser contexts within a single browser instance (1–10, default 1).

### Browser engine (DIF-002)

Pass a `browser` field to run the tests under a specific Playwright engine:

| Value | Notes |
|---|---|
| `"chromium"` | Default. Required for crawl, recorder, and live browser view (they depend on CDP). |
| `"firefox"` | Playwright's bundled Gecko build. |
| `"webkit"` | Playwright's bundled Safari engine. macOS / iOS Safari parity. |

Invalid or unknown values silently fall back to chromium (no error). The canonical browser name is persisted on the run record (`runs.browser` column, migration 009) and returned on `GET /runs/:runId` so the Run Detail page can show a per-run badge.

Baselines (visual regression — DIF-001) are currently keyed by `(testId, stepNumber)` only, not by browser. Running the same test under Firefox and Chromium against the same baseline will produce spurious pixel regressions due to font-rendering differences. Browser-aware baselines are tracked as a separate follow-on.

### Device emulation (DIF-003)

Pass a `device` field in the request body to run tests with a Playwright device profile. The device name is looked up in [`playwright.devices`](https://playwright.dev/docs/emulation#devices) and applies viewport, user agent, touch emulation, and device scale factor to the browser context.

Available presets (also shown in the UI dropdown):

| Label | Value |
|---|---|
| Desktop (default) | `""` (omit or empty) |
| iPhone 14 | `"iPhone 14"` |
| iPhone 14 Pro Max | `"iPhone 14 Pro Max"` |
| iPhone 12 | `"iPhone 12"` |
| iPad (gen 7) | `"iPad (gen 7)"` |
| iPad Pro 11 | `"iPad Pro 11"` |
| Galaxy S9+ | `"Galaxy S9+"` |
| Pixel 7 | `"Pixel 7"` |
| Pixel 5 | `"Pixel 5"` |
| Galaxy Tab S4 | `"Galaxy Tab S4"` |
| Desktop Chrome HiDPI | `"Desktop Chrome HiDPI"` |
| Desktop Firefox HiDPI | `"Desktop Firefox HiDPI"` |

Any name from `playwright.devices` is accepted — the presets above are a curated subset for the UI.

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
