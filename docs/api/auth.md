# Authentication API

## Cookie-Based Auth

All auth endpoints set JWT tokens in **HttpOnly; Secure; SameSite=Strict** cookies. The token is never returned in response bodies. A companion `token_exp` cookie (Non-HttpOnly) exposes only the expiry timestamp for frontend UX.

All mutating endpoints are protected by **CSRF double-submit cookie** validation. The frontend must send the value of the `_csrf` cookie in the `X-CSRF-Token` header on POST/PATCH/PUT/DELETE requests.

## Register

```
POST /api/auth/register
```

**Body:**
```json
{
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "password": "min8chars"
}
```

**Response:** `201 Created`
```json
{ "message": "Account created successfully." }
```

## Sign In

```
POST /api/auth/login
```

**Body:**
```json
{
  "email": "ada@example.com",
  "password": "min8chars"
}
```

**Response:** `200 OK`

Sets `access_token` (HttpOnly) and `token_exp` cookies. Body:
```json
{
  "user": {
    "id": "uuid",
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "role": "user",
    "avatar": null
  }
}
```

Rate limited to **10 attempts per IP per 15 minutes**.

## Sign Out

```
POST /api/auth/logout
```

Requires a valid `access_token` cookie. Revokes the token server-side and clears auth cookies.

## Refresh Session

```
POST /api/auth/refresh
```

Requires a valid `access_token` cookie. Revokes the old token, issues a new one, and resets cookie TTL. Called proactively by the frontend 5 minutes before expiry.

**Response:** `200 OK` — same shape as login (`{ user }`).

## Get Current User

```
GET /api/auth/me
```

Requires a valid `access_token` cookie (or `Authorization: Bearer` header as fallback).

## OAuth — GitHub

```
GET /api/auth/github/callback?code=<code>
```

Exchanges a GitHub OAuth code for a user profile and sets auth cookies. Requires `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` env vars on the server.

## OAuth — Google

```
GET /api/auth/google/callback?code=<code>
```

Exchanges a Google OAuth code for a user profile and sets auth cookies. Requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars on the server.

## Token Format

JWTs are signed with HS256 and expire after **8 hours**. Stored in the `access_token` HttpOnly cookie — never exposed to JavaScript. Payload:

```json
{
  "sub": "user-uuid",
  "email": "ada@example.com",
  "role": "user",
  "jti": "unique-token-id",
  "iat": 1700000000,
  "exp": 1700028800
}
```

## Auth Fallbacks

For backward compatibility, `requireAuth` also accepts:
1. `Authorization: Bearer <token>` header (for direct API consumers, test scripts)
2. `?token=<jwt>` query parameter (for SSE EventSource in environments where cookies are unavailable)
