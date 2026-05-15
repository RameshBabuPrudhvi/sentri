# Tests API

> All test endpoints are under `/api/v1/` (INF-005). Legacy `/api/*` paths are 308-redirected.

## List Tests for a Project

```
GET /api/v1/projects/:id/tests
```

Returns non-deleted tests for the project. Supports optional pagination:

```
GET /api/v1/projects/:id/tests?page=1&pageSize=10
```

When `page` or `pageSize` is provided, the response shape changes to `{ data: [], meta: { total, page, pageSize, hasMore } }`. Without pagination params, returns a flat array (backward-compatible). Default `pageSize` is 10 (max 200).

**Optional filters** (only apply when paginated):

| Param | Values | Description |
|---|---|---|
| `reviewStatus` | `draft`, `approved`, `rejected` | Filter by review status |
| `category` | `api`, `ui` | Filter by test category |
| `search` | free text | Search against test name and source URL |
| `stale` | `true` | Return only stale tests (AUTO-013) |

Example with filters:
```
GET /api/v1/projects/:id/tests?page=1&pageSize=10&reviewStatus=draft&category=ui&search=login
```

## List All Tests

```
GET /api/v1/tests
```

Returns all non-deleted tests across all projects. Supports the same `?page=N&pageSize=N` pagination as above.

## Get a Test

```
GET /api/v1/tests/:testId
```

## Create a Manual Test

```
POST /api/v1/projects/:id/tests
```

**Body:**
```json
{
  "name": "User can add item to cart",
  "steps": [
    { "action": "navigate", "url": "/products" },
    { "action": "click", "selector": "button.add-to-cart" },
    { "action": "assert", "selector": ".cart-count", "expected": "1" }
  ]
}
```

Test is saved as **Draft** — must be approved before it runs in regression.

## Generate Test from Description

```
POST /api/v1/projects/:id/tests/generate
```

**Body:**
```json
{
  "name": "Search returns relevant results",
  "description": "As a user I want to search for a keyword and see matching results...",
  "dialsConfig": { ... }
}
```

Returns a `runId` to track generation progress via SSE.

## Edit a Test

```
PATCH /api/v1/tests/:testId
```

## Delete a Test

```
DELETE /api/v1/projects/:id/tests/:testId
```

Soft-deletes the test (moves it to the Recycle Bin). Restore via `POST /api/v1/restore/test/:testId`.

## Run a Single Test

```
POST /api/v1/tests/:testId/run
```

## Review Actions

| Method | Endpoint | Action |
|---|---|---|
| `PATCH` | `/api/v1/projects/:id/tests/:testId/approve` | Draft → Approved |
| `PATCH` | `/api/v1/projects/:id/tests/:testId/reject` | Draft → Rejected |
| `PATCH` | `/api/v1/projects/:id/tests/:testId/restore` | Any → Draft |

## Bulk Actions

```
POST /api/v1/projects/:id/tests/bulk
```

**Body:**
```json
{
  "testIds": ["TC-1", "TC-2", "TC-3"],
  "action": "approve"   // "approve" | "reject" | "restore" | "delete"
}
```

The `"delete"` action soft-deletes tests (moves them to the Recycle Bin).

## Test Counts

```
GET /api/v1/projects/:id/tests/counts
```

Lightweight endpoint returning per-status test counts without fetching row data. Used by the frontend for filter pills, tab badges, and stats.

**Response:**
```json
{
  "draft": 5,
  "approved": 12,
  "rejected": 2,
  "passed": 10,
  "failed": 2,
  "api": 3,
  "ui": 16,
  "stale": 3,
  "total": 19
}
```

The `stale` field counts approved tests that haven't been run in `STALE_TEST_DAYS` (default 90 days). A weekly background job flags stale tests automatically (AUTO-013).

## Export

### Zephyr Scale CSV

```
GET /api/v1/projects/:id/tests/export/zephyr?status=approved
```

Returns a CSV file formatted for Zephyr Scale import. Optional `status` filter.

### TestRail CSV

```
GET /api/v1/projects/:id/tests/export/testrail?status=approved
```

Returns a CSV file formatted for TestRail bulk import. Optional `status` filter.

### Standalone Playwright project ZIP (DIF-006)

```
GET /api/v1/projects/:id/export/playwright
```

Returns a ZIP archive (`Content-Type: application/zip`) containing a runnable
Playwright project assembled from the project's **approved** tests. Draft and
rejected tests are excluded. The archive contains:

- `package.json` — declares `@playwright/test` as a dev dependency
- `playwright.config.ts` — `baseURL` is set to the project's `url` (or
  `http://localhost:3000` when the project has no URL)
- `README.md` — instructions to run `npm install && npx playwright test`
- `tests/<slug>.spec.ts` — one file per approved test, wrapped in a
  canonical `test('<name>', async ({ page }) => { … })` block. Filenames are
  slugged from the test name (`[^a-z0-9]+` → `-`); collisions across tests
  with names that normalize to the same slug are disambiguated with a numeric
  suffix (`-2`, `-3`, …).

Returns `404` when the project does not exist or is outside the caller's
workspace (matches the convention used by every other route to avoid leaking
project existence across workspaces — ACL-001).

Returns `503` with `{ code: "ZIP_BINARY_MISSING", error, hint }` when the
backend host is missing the system `zip` binary. The implementation shells
out to `zip` instead of pulling in a new npm runtime dependency, so
deployments on minimal Docker bases (e.g. `node:alpine` without `apk add
zip`) or Windows dev boxes without the binary on `$PATH` surface this as an
operator-fixable 503 rather than an opaque 500. Install `zip` on the host
(`apt-get install zip` / `apk add zip`; macOS ships it) to resolve.

Returns `500` for any other internal failure during archive assembly.

### Traceability Matrix

```
GET /api/v1/projects/:id/tests/traceability
```

Returns a JSON traceability matrix grouping tests by `linkedIssueKey`, with an `unlinked` array for tests without issue links.

## Visual Regression Baselines (DIF-001, DIF-002b)

Baselines are the "golden" screenshots that subsequent runs diff against. A
baseline is created lazily on the first run that produces a screenshot for a
given `(testId, stepNumber, browser)` tuple; subsequent runs produce a diff
PNG under `artifacts/diffs/` and flag the step as a regression when the pixel
difference exceeds `VISUAL_DIFF_THRESHOLD` (default 2 %).

Baselines are **browser-scoped** (DIF-002b, migration 010) — Firefox and
WebKit captures keep separate goldens from Chromium, so cross-browser runs no
longer trigger spurious diffs from font-rendering differences. The on-disk
layout is `artifacts/baselines/<testId>/<browser>/step-<N>.png`. Pre-upgrade
chromium baselines (created before migration 010) remain effective via a
legacy-path fallback in `ensureBaseline()` until the next accept rewrites
them under the new layout.

### List Baselines

```
GET /api/v1/tests/:testId/baselines
GET /api/v1/tests/:testId/baselines?browser=firefox
```

Returns all stored baselines for the test, ordered by `(browser, stepNumber)`
when no filter is supplied, or by `stepNumber` when filtered to a single
browser.

**Response:**
```json
[
  {
    "testId": "TC-1",
    "stepNumber": 0,
    "browser": "chromium",
    "imagePath": "/artifacts/baselines/TC-1/chromium/step-0.png",
    "width": 1280,
    "height": 720,
    "createdAt": "2026-04-23T10:00:00.000Z",
    "updatedAt": "2026-04-23T10:00:00.000Z"
  }
]
```

`stepNumber = 0` is the final end-of-test screenshot; `stepNumber >= 1`
correspond to per-step captures (DIF-016).

### Accept a Baseline

```
POST /api/v1/tests/:testId/baselines/:stepNumber/accept
POST /api/v1/tests/:testId/baselines/:stepNumber/accept?browser=firefox
```

Requires `qa_lead` role. Promotes a captured screenshot from an earlier run
to the new baseline for the given step and browser.

**Body:**
```json
{ "runId": "RUN-42", "browser": "firefox" }
```

The browser is resolved in this priority order: `?browser=` query param →
`browser` field in the request body → the run's own `browser` field →
`"chromium"`. Invalid values fall back to chromium silently.

The source PNG must live under `/artifacts/screenshots/` — the route rejects
paths outside `SHOTS_DIR` with HTTP 400. The response includes the resolved
browser: `{ ok: true, baselinePath, testId, browser, stepNumber }`.

### Delete a Baseline

```
DELETE /api/v1/tests/:testId/baselines/:stepNumber
DELETE /api/v1/tests/:testId/baselines/:stepNumber?browser=firefox
```

Requires `qa_lead` role. Removes the DB row and the on-disk PNG for the
specified browser (defaults to `chromium`). The next run on that browser
will create a fresh baseline from its capture. Idempotent — returns
`{ ok: true, deleted: 0, browser }` when no baseline exists for that step.

## Interactive Recorder (DIF-015)

Opens a server-side Playwright browser at the project URL, streams the live
CDP screencast to the frontend via SSE, and forwards canvas pointer /
keyboard / wheel events back into the headless page via CDP `Input.dispatch*`
calls. The recorder captures click / dblclick / rightClick / hover / fill /
press / select / check / uncheck / upload / drag / navigation events plus
manual assertions (visible / text / value / URL). On stop, captured actions
are transformed into a Playwright test body and persisted as a Draft test
using `safeClick` / `safeFill` so the self-healing transform takes over at
execution time.

> The recorder works with the default `BROWSER_HEADLESS=true` (PR #115) —
> the canvas is interactive even when Chromium has no visible window. See
> REVIEW.md § "Testing DIF-001 (Visual Regression) and DIF-015 (Recorder)"
> for the full gotcha list.

### Start a Recording

```
POST /api/v1/projects/:id/record
```

Requires `qa_lead` role. Rate-limited via the expensive-operations limiter.

**Body (optional):**
```json
{
  "startUrl": "https://example.com",
  "device": "iPhone 14"
}
```

`device` is an optional Playwright device profile name from the curated
`DEVICE_PRESETS` allowlist (see `backend/src/runner/config.js`). Empty
string or omitted → desktop default. Unknown values return `400 { error:
"Invalid device: <name>" }`. The list mirrors `RunRegressionModal`'s
device dropdown so test-run + recording device coverage stay byte-aligned
(DIF-015c Gap 5).

Defaults to the project's configured URL. Returns
`{ sessionId, startUrl, device, viewport: { width, height } }`. The
`viewport` reflects the resolved device descriptor (e.g. `iPhone 14`
→ `{ width: 390, height: 844 }`) or the server-side `VIEWPORT_WIDTH` /
`VIEWPORT_HEIGHT` defaults so the frontend can scale forwarded pointer
coordinates correctly. The frontend subscribes to
`/api/v1/runs/:sessionId/events` for live screencast frames.

### Stop / Save / Discard

```
POST /api/v1/projects/:id/record/:sessionId/stop
```

Requires `qa_lead` role.

**Body — save as Draft test:**
```json
{ "name": "Login happy path" }
```

Returns `201 { test, actionCount }`. When the `MAX_RECORDING_MS` safety-net
timeout already tore down the session, the response additionally includes
`recoveredFromAutoTimeout: true`.

**Body — discard without persisting:**
```json
{ "discard": true }
```

Tears down the server-side browser without creating a Draft test.

### Forward Canvas Input Events

```
POST /api/v1/projects/:id/record/:sessionId/input
```

Requires `qa_lead` role. Exempt from the global rate limiter — input events
arrive at ~30fps during active use; the route is cheap (one async CDP
`Input.dispatch*` send) and already gated by role + workspace scope.

**Body** (CDP-shaped):
```json
{
  "type": "mousePressed",
  "x": 320, "y": 180,
  "button": 0,
  "clickCount": 1,
  "modifiers": 0
}
```

`type` must be one of `mousePressed`, `mouseReleased`, `mouseMoved`,
`keyDown`, `keyUp`, `char`, `scroll`. For mouse events, `button` follows the
DOM `MouseEvent.button` convention (0=left, 1=middle, 2=right); omit for
idle moves so CDP dispatches `"none"` instead of interpreting an idle
hover as a left-button drag. For non-printable keys, include the DOM
`keyCode` so CDP populates `windowsVirtualKeyCode` — without it Backspace,
Enter, Tab, and arrow keys fire but have no effect on the page.

Returns `200 { ok: true }`. Returns 404 if the session has ended (auto
timeout) or if `req.params.id` doesn't match the session's project.

### Add a Manual Assertion

```
POST /api/v1/projects/:id/record/:sessionId/assertion
```

Requires `qa_lead` role. Adds an assertion step to the in-flight recording
without forwarding any browser input.

**Body:**
```json
{
  "kind": "assertText",
  "selector": "#toast",
  "label": "Save confirmation",
  "value": "Saved"
}
```

`kind` must be one of `assertVisible`, `assertText`, `assertValue`,
`assertUrl`, `assertCount`, or `assertHasClass` (DIF-015c Gap 2).
`selector` is required for everything except `assertUrl`; `value` is
required for `assertText`, `assertValue`, `assertUrl`, `assertCount`,
and `assertHasClass`. `assertCount` additionally requires a
non-negative-integer-parseable value (e.g. `"3"`); anything else
(`"-1"`, `"1.5"`, `"abc"`) returns `400 { error: "Invalid assertion:
value for assertCount must be a non-negative integer." }`. Returns
`201 { ok: true, action }`. Returns 400 on incomplete payloads — the
route rejects assertions that would later be silently dropped by the
codegen (e.g. an `assertText` without a value).

The two count + class kinds emit:

- `assertCount` → `await expect(locator).toHaveCount(N)`
- `assertHasClass` → `await expect(locator).toHaveClass(new RegExp('(^|\\s)<class>(\\s|$)'))`
  (word-boundary regex so partial-class matches like `is-loading` /
  `is-active` work as expected against multi-class attributes)

### Poll Recording Status

```
GET /api/v1/projects/:id/record/:sessionId
```

Returns the live session status and the captured-action list for the
RecorderModal sidebar:

```json
{
  "sessionId": "REC-abc12345",
  "status": "recording",
  "url": "https://example.com",
  "startedAt": 1713873600000,
  "actionCount": 3,
  "actions": [
    { "kind": "goto",  "url": "https://example.com", "ts": 1713873600000 },
    { "kind": "click", "selector": "role=button[name=\"Sign in\"]", "label": "Sign in", "ts": 1713873601500 },
    { "kind": "fill",  "selector": "#email", "label": "Email", "value": "u@x.com", "ts": 1713873602100 }
  ]
}
```

Each action additionally carries (when applicable):

- `label` — friendly label (aria-label / inner text / placeholder) used by
  the Test Detail Steps panel so reviewers see `User clicks the "Sign in"
  button` instead of the raw selector.
- `target` — for `drag` actions, the drop-target selector.
- `pageAlias` — `"page"` for the main tab, `"popup1"`, `"popup2"`, … for
  popups. Wired through to the generated Playwright code via `ensurePopup()`.
- `frameUrl` — when the action originated inside an iframe, the frame's URL
  (used by `ensureFrame()` in the generated code).

### Pause / Resume Capture (DIF-015c Gap 3)

```
POST /api/v1/projects/:id/record/:sessionId/pause
POST /api/v1/projects/:id/record/:sessionId/resume
```

Requires `qa_lead` role. Workspace-scoped via the session's parent
project (matches the convention used by the other recorder routes;
cross-workspace sessionId guesses return 404, not 403, so existence
isn't leaked).

`pause` flips `session.paused = true`. While paused the browser stays
open and the screencast keeps streaming, but **four** capture sites
honour the flag and skip action emission:

- `forwardInput` (`/input` route) short-circuits CDP dispatch so the
  operator can navigate the SUT without polluting `actions[]`.
- The `__sentriRecord` exposeBinding callback drops DOM-emitted events
  (debounced fills flushing, framework re-renders firing change handlers,
  programmatic clicks fired by page JS) that started before pause but
  settled after.
- The popup `framenavigated` listener skips synthesised `goto` actions
  on newly-opened tabs.
- The debounced main-page `framenavigated` flush drops settled
  navigations that started before pause.

`resume` flips it back. Both routes are idempotent: pausing an
already-paused session and resuming a never-paused session are no-ops.
Both return `{ ok: true, paused: <bool> }`.

### Undo Last Captured Step (DIF-015c Gap 3)

```
POST /api/v1/projects/:id/record/:sessionId/pop-last
```

Requires `qa_lead` role. Pops the most recent entry from
`session.actions[]` and returns it for an optional client-side
optimistic update. Idempotent on an empty list — returns
`{ ok: true, removed: null, actionCount: 0 }` rather than 4xx so the
UI can fire the button without first checking the step count.

**Response:**
```json
{ "ok": true, "removed": { "kind": "click", "selector": "#ok", "ts": 1713873601500 }, "actionCount": 4 }
```

### Switch Device Mid-Session (DIF-015c Gap 5)

```
POST /api/v1/projects/:id/record/:sessionId/device
```

Requires `qa_lead` role. **Tears down the page + Playwright context and
rebuilds them under the new descriptor against the same browser process**
— Playwright applies device emulation (userAgent, viewport,
deviceScaleFactor, hasTouch, locale) only at `browser.newContext()` time,
so an honest mid-session swap means a fresh context. Captured
`session.actions[]` **survive** the switch (operator's step history is
not lost), but page state (cookies, partially-filled forms, scroll
position, in-flight requests) does not. The frontend gates the call
behind a confirmation modal that explains the trade-off.

**Body:**
```json
{ "device": "iPhone 14" }
```

Empty string = desktop default. Validated against the same
`DEVICE_PRESETS` allowlist used at session launch — unknown values
return `400 { error: "Invalid device: <name>" }`. Idempotent on the
active device (returns the current viewport without touching the
context, mirroring how `resume` no-ops on a never-paused session).

**Response:**
```json
{ "ok": true, "device": "iPhone 14", "viewport": { "width": 390, "height": 844 }, "url": "https://example.com/login" }
```

The frontend reads the new `viewport` to resize the canvas; subsequent
`probe` and `input` calls flow through `LiveBrowserView`'s existing
coordinate scaling against the new viewport prop.

Returns `500 { error: "Device switch failed — recorder torn down. Re-launch the recorder to continue." }`
when the rebuild fails (rare — browser process gone). The session is
left in `stopping` state so any subsequent recorder route on the same
sessionId returns 404 cleanly.

### Probe Element Under Cursor (DIF-015c Gap 2)

```
POST /api/v1/projects/:id/record/:sessionId/probe
```

Requires `qa_lead` role. Read-only probe that resolves the
`{selector, label, rect}` for an arbitrary viewport coordinate so the
frontend can highlight the hovered element and pre-fill the
"Add verification" form on click. **Does not record an action.**
Mirrors how Playwright codegen's inspector probes the page under the
cursor.

**Body:**
```json
{ "x": 320, "y": 180 }
```

Coordinates are in viewport space (already scaled by
`LiveBrowserView.scaleCoords` from CSS pixels). The route validates
that both are finite numbers; malformed inputs return
`400 { error: "x and y must be finite numbers" }`. The probe itself
clamps to non-negative integers before reaching the page, so a
fractional or negative payload that survives JSON parsing still
produces a sensible probe rather than crashing CDP.

**Response (interactive ancestor found):**
```json
{
  "probe": {
    "selector": "role=button[name=\"Sign in\"]",
    "label": "Sign in",
    "rect": { "x": 100, "y": 200, "width": 80, "height": 32 }
  }
}
```

**Response (no interactive ancestor under cursor):**
```json
{ "probe": null }
```

The page-side helper (`window.__sentriProbeAtPoint`, installed by
`RECORDER_SCRIPT`) walks to the closest interactive ancestor
(`a, button, input, textarea, select, [role], [data-testid], [data-test-id], [contenteditable='true']`)
and reuses the SAME `selectorGenerator` + `bestLabel` heuristics the
click/fill listeners use — so the picker's suggestion is byte-aligned
with what a real click would have captured.

The probe is best-effort: transient page-navigation errors
(`page.evaluate` rejects mid-probe) are swallowed and return
`{ probe: null }` so the frontend just drops the highlight rather than
surfacing a 500. Safe to call at hover frequency (the frontend
debounces to ~120 ms, so the route handles ~8 req/sec per session).
