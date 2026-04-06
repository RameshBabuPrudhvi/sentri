# API Reference

The Sentri backend exposes a RESTful JSON API on port `3001` by default.

**Base URL:** `http://localhost:3001/api`

## Authentication

Protected endpoints require a `Bearer` token in the `Authorization` header:

```
Authorization: Bearer <jwt-token>
```

Obtain a token via [`POST /api/auth/login`](/api/auth) or OAuth callback.

## Endpoints

| Section | Description |
|---|---|
| [Projects](/api/projects) | Create, list, get, delete projects |
| [Tests](/api/tests) | CRUD, generate, review (approve/reject/restore), bulk actions |
| [Runs](/api/runs) | Execute tests, get results, SSE event stream, abort |
| [Settings](/api/settings) | AI provider config, Ollama status, system info |
| [Authentication](/api/auth) | Register, sign in, OAuth (GitHub/Google), token management |

## Common Patterns

### Error Responses

All errors return JSON with an `error` field:

```json
{ "error": "Invalid email or password." }
```

### Rate Limiting

The sign-in endpoint is rate-limited to **10 attempts per IP per 15 minutes**. When exceeded:

```
HTTP 429 Too Many Requests
Retry-After: <seconds>
```

### SSE Event Stream

Run events are streamed via Server-Sent Events at `GET /api/runs/:runId/events`. Event types:

| Event | Description |
|---|---|
| `log` | Real-time log message |
| `result` | Per-test pass/fail result |
| `frame` | CDP screencast frame (base64 JPEG) |
| `done` | Run completed — includes final status |
