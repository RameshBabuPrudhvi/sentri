# Authentication

Sentri includes a built-in authentication system with email/password sign-in and OAuth (GitHub, Google).

## Email / Password

- Passwords hashed with **scrypt** (64-byte key, 16-byte random salt)
- JWTs signed with **HS256**, 8-hour expiry
- Rate limiting: 10 sign-in attempts per IP per 15 minutes

## OAuth

Supports GitHub and Google. Configure via environment variables:

```bash
# GitHub
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# Google
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-app.com/login?provider=google
```

Frontend env vars (build-time):
```bash
VITE_GITHUB_CLIENT_ID=...
VITE_GOOGLE_CLIENT_ID=...
```

## JWT Secret

::: danger Production Requirement
Set `JWT_SECRET` to a random 32+ character string in production. The server will **refuse to start** without it when `NODE_ENV=production`.
:::

Generate one:
```bash
openssl rand -base64 48
```

## Token Storage

JWTs are stored in **HttpOnly; Secure; SameSite=Strict** cookies (`access_token`) — never in `localStorage` or JavaScript-accessible storage. This eliminates XSS-based token theft entirely.

A companion `token_exp` cookie (Non-HttpOnly) exposes only the numeric expiry timestamp so the frontend can drive proactive refresh UX without ever reading the JWT.

All mutating API requests are protected by a **CSRF double-submit cookie** (`_csrf`). The frontend reads this cookie and sends its value in the `X-CSRF-Token` header.

The `AuthContext` provider handles:
- Proactive session refresh (5 minutes before expiry via `POST /api/auth/refresh`)
- 401 response interception → automatic session clear and redirect
- Server-side token revocation on sign-out (clears cookies)

## Protected Routes

All routes except `/login` are wrapped in `<ProtectedRoute>`. Unauthenticated users are redirected to the sign-in page with their original destination saved.
