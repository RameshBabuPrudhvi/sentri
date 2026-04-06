# Tests API

## List Tests for a Project

```
GET /api/projects/:id/tests
```

## List All Tests

```
GET /api/tests
```

Returns all tests across all projects.

## Get a Test

```
GET /api/tests/:testId
```

## Create a Manual Test

```
POST /api/projects/:id/tests
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
POST /api/projects/:id/tests/generate
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
PATCH /api/tests/:testId
```

## Delete a Test

```
DELETE /api/projects/:id/tests/:testId
```

## Run a Single Test

```
POST /api/tests/:testId/run
```

## Review Actions

| Method | Endpoint | Action |
|---|---|---|
| `PATCH` | `/api/projects/:id/tests/:testId/approve` | Draft → Approved |
| `PATCH` | `/api/projects/:id/tests/:testId/reject` | Draft → Rejected |
| `PATCH` | `/api/projects/:id/tests/:testId/restore` | Any → Draft |

## Bulk Actions

```
POST /api/projects/:id/tests/bulk
```

**Body:**
```json
{
  "testIds": ["TC-1", "TC-2", "TC-3"],
  "action": "approve"   // "approve" | "reject" | "restore" | "delete"
}
```
