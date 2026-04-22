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

**Cross-origin deployments** (e.g. GitHub Pages + Render): The `_csrf` cookie is set on the backend domain and is invisible to `document.cookie` on the frontend origin. In this case the backend echoes the CSRF token in an `X-CSRF-Token` **response** header (exposed via `Access-Control-Expose-Headers`). The frontend captures it from every response via `setCsrfToken()` and caches it in memory for subsequent mutating requests.

The `AuthContext` provider handles:
- Proactive session refresh (5 minutes before expiry via `POST /api/v1/auth/refresh`)
- 401 response interception → automatic session clear and redirect
- Server-side token revocation on sign-out (clears cookies)

## Workspaces (ACL-001)

Every user belongs to at least one **workspace**. A personal workspace is auto-created on first login. All entities (projects, tests, runs, activities) are scoped to the active workspace — users in one workspace cannot see data from another.

- **Workspace switching** — Users with multiple workspaces can switch via the sidebar dropdown or `POST /api/workspaces/switch`. A new JWT is issued with the target workspace as a routing hint.
- **Workspace members** — Admins can invite users, update roles, and remove members via `/api/workspaces/current/members`.
- **Default backfill** — On startup, `ensureDefaultWorkspaces()` creates workspaces for any existing users and assigns orphaned entities.

The JWT carries `workspaceId` as a **hint only**. Authorization is always resolved from the `workspace_members` table at request time so that permission changes take effect immediately.

## Role-Based Access Control (ACL-002)

Each workspace member has a role with a strict hierarchy:

| Role | Weight | Can do |
|---|---|---|
| `admin` | 30 | Everything — settings, data deletion, member management, plus all below |
| `qa_lead` | 20 | Create/edit/delete projects, tests, runs, schedules, plus all below |
| `viewer` | 10 | Read-only access to all workspace data |

The `requireRole(minimumRole)` middleware (in `backend/src/middleware/requireRole.js`) guards all mutating API routes. The `workspaceScope` middleware injects `req.workspaceId` and `req.userRole` from the database on every request.

**Frontend gating:** The `<ProtectedRoute requiredRole="admin">` component restricts page access by role, and `userHasRole(user, role)` from `frontend/src/utils/roles.js` hides UI elements (buttons, nav links) for insufficient roles. These are UX-only — the backend is the source of truth.

## Protected Routes

All routes except `/login` are wrapped in `<ProtectedRoute>`. Unauthenticated users are redirected to the sign-in page with their original destination saved. The Settings page requires `admin` role.
