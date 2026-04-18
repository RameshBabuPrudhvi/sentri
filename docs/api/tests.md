# Tests API

> All test endpoints are under `/api/v1/` (INF-005). Legacy `/api/*` paths are 301-redirected.

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
  "total": 19
}
```

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

### Traceability Matrix

```
GET /api/v1/projects/:id/tests/traceability
```

Returns a JSON traceability matrix grouping tests by `linkedIssueKey`, with an `unlinked` array for tests without issue links.
