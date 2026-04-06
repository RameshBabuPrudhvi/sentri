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

Tokens are stored in `localStorage` on the client. The `AuthContext` provider handles:
- Auto-logout when token expires (polled every 60s)
- 401 response interception → automatic session clear
- Server-side token revocation on sign-out

## Protected Routes

All routes except `/login` are wrapped in `<ProtectedRoute>`. Unauthenticated users are redirected to the sign-in page with their original destination saved.
