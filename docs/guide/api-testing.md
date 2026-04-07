# API Test Generation

Sentri generates **Playwright `request` API tests** alongside browser UI tests. API tests call HTTP endpoints directly — no browser needed — and verify status codes, JSON response shapes, and error handling.

## Two ways to generate API tests

### 1. Automatic (during Crawl & Generate)

When you click **Crawl & Generate** on a project, Sentri:

1. Launches Chromium and crawls your app
2. **Captures every fetch/XHR call** the app makes (HAR capture)
3. Deduplicates endpoints by pattern (e.g. `/api/users/123` → `/api/users/:id`)
4. Feeds the captured endpoints to the AI to generate API contract tests

**No config needed** — if your app makes client-side API calls during page load, API tests appear automatically. Works best with SPAs (React, Vue, Angular) that fetch data via `/api/*` endpoints.

::: tip Use State Exploration for more API coverage
Link crawl only captures API calls made during page load. **State exploration** mode clicks buttons and submits forms, triggering many more API calls. Select 🔍 **State exploration** in the explore mode selector before crawling.
:::

### 2. From description (Generate Test modal)

Open the **Generate a Test Case** modal and describe what you want. Sentri auto-detects API intent from your text and routes to the API test prompt.

#### Example prompts that trigger API test generation

**Simple — just a URL:**
```
Name: API register tests
Description: write API tests for https://reqres.in/api/register
```

**With specific endpoints:**
```
Name: User CRUD API tests
Description:
Test these endpoints:
GET /api/users - list all users
POST /api/users - create a new user
GET /api/users/:id - get user by ID
PUT /api/users/:id - update user
DELETE /api/users/:id - delete user
```

**With request/response examples:**
```
Name: Registration API
Description:
POST /api/register
Request: { "email": "eve.holt@reqres.in", "password": "pistol" }
Response: { "id": 4, "token": "QpwL5tke4Pnpja7X4" }
```

**With an OpenAPI spec (paste as description or attach as .json file):**
```json
{
  "openapi": "3.0.0",
  "paths": {
    "/api/register": {
      "post": {
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "properties": {
                  "email": { "type": "string", "format": "email" },
                  "password": { "type": "string" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Success" },
          "400": { "description": "Missing fields" }
        }
      }
    }
  }
}
```

### Keywords that trigger API mode

Sentri detects API intent when your name or description contains any of:

- `API`, `REST`, `GraphQL`
- `endpoint`, `endpoints`
- HTTP methods before a path: `GET /api/users`, `POST /login`
- `status code`, `request body`, `response body`
- `json response`, `json payload`
- `contract test`
- URL paths containing `/api/`

## What the generated tests look like

API tests use Playwright's `request` API context instead of `page`:

```js
import { test, expect } from '@playwright/test';

test('API: POST /api/register - successful registration', async ({ request }) => {
  const api = await request.newContext({ baseURL: 'https://reqres.in' });
  const res = await api.post('/api/register', {
    data: { email: 'eve.holt@reqres.in', password: 'pistol' }
  });

  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('id');
  expect(body).toHaveProperty('token');
  expect(body.error).toBeUndefined();

  await api.dispose();
});
```

## Test coverage categories

The AI generates tests across five categories:

| Category | What it tests |
|---|---|
| **Positive** | Valid requests return expected status and JSON shape |
| **Negative** | Invalid/missing fields return appropriate error codes |
| **Error payloads** | APIs that return 200 with error bodies (common pattern) |
| **Contract** | Response bodies match the observed/specified structure |
| **Edge cases** | Empty bodies, wrong methods, missing headers |

## Identifying API tests in the UI

API tests are marked with a **🌐 API** badge in the test list. You can filter by category using the **UI / 🌐 API** pills in the filter bar on both the project and global tests pages.

## OpenAPI spec support

Paste an OpenAPI 3.x or Swagger 2.x JSON spec as the description (or attach it as a `.json` file). Sentri parses it and extracts:

- All endpoints with their HTTP methods
- Request body schemas → generates example payloads
- Response schemas → generates assertion targets
- Status codes → tests both success and error paths
- `$ref` resolution for shared component schemas

This produces much higher quality tests than freeform description because the AI has the exact contract to assert against.
