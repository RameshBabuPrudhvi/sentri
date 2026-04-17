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
  "password": "Min8chars!"
}
```

Password must contain at least 8 characters with one uppercase, one lowercase, one digit, and one special character.

**Response:** `201 Created`

When email verification is enabled (default):
```json
{
  "message": "Account created. Please check your email to verify your account.",
  "requiresVerification": true
}
```

When `SKIP_EMAIL_VERIFICATION=true` (dev/CI only):
```json
{ "message": "Account created successfully." }
```

The user is created with `emailVerified = 0` and must verify their email before logging in. A verification email is sent via the configured transport (Resend, SMTP, or console fallback).

## Verify Email

```
GET /api/auth/verify?token=<verification-token>
```

Called when the user clicks the verification link in their email. Marks the user as verified and invalidates any remaining unused tokens.

**Response:** `200 OK`
```json
{ "message": "Email verified successfully. You can now sign in.", "verified": true }
```

Returns `400` for invalid, expired, or already-used tokens.

## Resend Verification Email

```
POST /api/auth/resend-verification
```

**Body:**
```json
{ "email": "ada@example.com" }
```

**Response:** `200 OK` (always — prevents user enumeration)
```json
{ "message": "If an unverified account with that email exists, a verification link has been sent." }
```

Rate limited to **5 requests per IP per 15 minutes** (shares bucket with forgot-password).

## Sign In

```
POST /api/auth/login
```

**Body:**
```json
{
  "email": "ada@example.com",
  "password": "Min8chars!"
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

**Error:** `403 Forbidden` — when the user has not verified their email:
```json
{
  "error": "Please verify your email address before signing in.",
  "code": "EMAIL_NOT_VERIFIED",
  "email": "ada@example.com"
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

## Password Reset

### Request Reset Token

```
POST /api/auth/forgot-password
```

**Body:**
```json
{ "email": "ada@example.com" }
```

**Response:** `200 OK` (always — prevents user enumeration)
```json
{ "message": "If an account with that email exists, a password reset link has been generated." }
```

Rate limited to **5 requests per IP per 15 minutes**. Tokens are persisted in the `password_reset_tokens` DB table (migration 003) and expire after **30 minutes**. Only the latest token per user is valid — requesting a new one invalidates prior tokens.

### Reset Password

```
POST /api/auth/reset-password
```

**Body:**
```json
{
  "token": "<reset-token-from-email>",
  "newPassword": "min8chars"
}
```

**Response:** `200 OK`
```json
{ "message": "Password has been reset successfully. You can now sign in." }
```

Returns `400` for invalid, expired, or already-used tokens. Tokens are one-time-use — claimed atomically to prevent concurrent replay.

## Token Format

JWTs are signed with HS256 and expire after **8 hours**. Stored in the `access_token` HttpOnly cookie — never exposed to JavaScript. Payload:

```json
{
  "sub": "user-uuid",
  "email": "ada@example.com",
  "name": "Ada Lovelace",
  "role": "user",
  "jti": "unique-token-id",
  "iat": 1700000000,
  "exp": 1700028800
}
```

The `name` field is used by the audit trail system to record who performed each action (via the `actor()` utility).

## Auth Fallbacks

For backward compatibility, `requireAuth` also accepts:
1. `Authorization: Bearer <token>` header (for direct API consumers, test scripts)
2. `?token=<jwt>` query parameter (for SSE EventSource in environments where cookies are unavailable)
