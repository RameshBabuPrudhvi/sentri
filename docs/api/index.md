# API Reference

The Sentri backend exposes a RESTful JSON API on port `3001` by default.

**Base URL:** `http://localhost:3001/api/v1`

> **Versioning (INF-005):** All endpoints are served under `/api/v1/`. Legacy `/api/*` paths are 301-redirected for backward compatibility.

## Authentication

Protected endpoints use **HttpOnly cookie-based auth**. After signing in via [`POST /api/v1/auth/login`](/api/auth) or an OAuth callback, the server sets an `access_token` cookie that the browser sends automatically on every request.

All mutating requests (POST, PATCH, PUT, DELETE) must also include the CSRF token in the `X-CSRF-Token` header (read from the `_csrf` cookie).

For direct API consumers (scripts, CI), a `Bearer` token in the `Authorization` header is still accepted as a fallback:

```
Authorization: Bearer <jwt-token>
```

## Endpoints

| Section | Description |
|---|---|
| [Projects](/api/projects) | Create, list, get, soft-delete projects, CI/CD trigger, trigger token management, cron schedules |
| [Tests](/api/tests) | CRUD, generate, review (approve/reject/restore), bulk actions, counts, pagination |
| [Runs](/api/runs) | Execute tests, get results, SSE event stream, abort, pagination |
| [Settings](/api/settings) | AI provider config, Ollama status, system info, recycle bin, data management |
| [Authentication](/api/auth) | Register, sign in, email verification, OAuth (GitHub/Google), password reset, token management |

## Common Patterns

### Error Responses

All errors return JSON with an `error` field:

```json
{ "error": "Invalid email or password." }
```

### Rate Limiting

Three tiers of rate limiting protect the API:

| Tier | Scope | Limit | Applied to |
|---|---|---|---|
| **General** | All `/api/*` routes | 300 req / 15 min per IP | Every API request |
| **Auth** | Login, forgot-password, reset-password | 5–10 req / 15 min per IP | Auth endpoints only |
| **Expensive ops** | Crawl, test run | 20 req / hr per IP | `POST /api/v1/projects/:id/crawl`, `/run`, `/tests/:id/run` |
| **AI generation** | Test generation | 30 req / hr per IP | `POST /api/v1/projects/:id/tests/generate` |

When exceeded:

```
HTTP 429 Too Many Requests
Retry-After: <seconds>
```

### SSE Event Stream

Run events are streamed via Server-Sent Events at `GET /api/v1/runs/:runId/events`. Event types:

| Event | Description |
|---|---|
| `log` | Real-time log message |
| `result` | Per-test pass/fail result |
| `snapshot` | Full run state — emitted after each result for real-time progress during parallel execution |
| `frame` | CDP screencast frame (base64 JPEG) |
| `done` | Run completed — includes final status |
