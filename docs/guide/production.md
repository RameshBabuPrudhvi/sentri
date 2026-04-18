# Production Checklist

## Required

- [ ] Set `NODE_ENV=production`
- [ ] Set `JWT_SECRET` to a random 32+ char string (`openssl rand -base64 48`)
- [ ] Set `ARTIFACT_SECRET` for signed artifact URLs (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- [ ] Configure at least one AI provider key
- [ ] Set `VITE_API_URL` at frontend build time (for cross-origin deploys)
- [ ] Set `CORS_ORIGIN` to your frontend domain(s)

## Database

- [x] ~~SQLite database~~ — Done (better-sqlite3 with WAL mode)
- [x] ~~PostgreSQL support~~ — Done (INF-001). Set `DATABASE_URL=postgres://…` to use PostgreSQL instead of SQLite. Install `pg` + `pg-native` (or `deasync` as fallback). Both backends use the same adapter interface — no code changes needed.

## Infrastructure

- [x] ~~Redis for rate limiting, token revocation, and SSE pub/sub~~ — Done (INF-002). Set `REDIS_URL=redis://…` to enable. Install `ioredis` + `rate-limit-redis`. Falls back to in-memory stores when not configured.
- [x] ~~Cron-based auto-runs~~ — Done (ENH-006). Configure per-project schedules via the Automation page.
- [x] ~~CI/CD webhook trigger~~ — Done (ENH-011). `POST /api/v1/projects/:id/trigger` with per-project Bearer tokens.
- [x] ~~Email verification on registration~~ — Done (SEC-001). Configure `RESEND_API_KEY` or `SMTP_HOST` for transactional email.
- [x] ~~Graceful shutdown~~ — Done (MAINT-013). Drains in-flight runs on SIGTERM/SIGINT.
- [x] ~~BullMQ durable background run execution~~ — Done (INF-003). When `REDIS_URL` is set and `bullmq` is installed, runs execute via a durable job queue with crash recovery, retry, and global concurrency control (`MAX_WORKERS`). Falls back to in-process execution without Redis.
- [x] ~~Failure notifications (Teams/email/webhook)~~ — Done (FEA-001). Configure per-project via `PATCH /api/projects/:id/notifications`. Dispatches on run completion with failures.
- [ ] Store videos and screenshots to S3/R2 instead of local disk (MNT-006)
- [x] ~~Workspace/organisation scoping for multi-tenancy~~ — Done (ACL-001). Every entity is scoped to a workspace via `workspaceId`. Workspaces auto-created on first login. Existing data backfilled on startup.
- [x] ~~Role-based access control~~ — Done (ACL-002). Three roles: Admin / QA Lead / Viewer. `requireRole()` middleware guards all mutating routes. Frontend gates Settings to admins and hides actions for insufficient roles.

## Security

- [x] OAuth state parameter validated
- [x] JWT secret throws in production if missing
- [x] Rate limiting — three-tier: general (300/15 min), auth (5–10/15 min), expensive ops (20/hr), AI generation (30/hr)
- [x] Passwords hashed with scrypt
- [x] JWT in HttpOnly; Secure; SameSite=Strict cookie (never in localStorage)
- [x] CSRF double-submit cookie on all mutating endpoints
- [x] No sensitive data in API responses (JWT never in response body)
- [x] Email verification required before login (SEC-001)
- [x] Artifact serving protected by HMAC-SHA256 signed URLs (ENH-007)
- [x] Gitleaks secrets scanning in CI (ENH-030)
- [x] DB-backed password reset tokens with atomic one-time claim (ENH-013)
- [x] ~~Nonce-based Content Security Policy~~ — Done (SEC-002). Per-request nonce replaces `'unsafe-inline'` in `script-src`. Vite plugin injects `nonce="__CSP_NONCE__"` on `<script>` tags; `serveIndexWithNonce()` replaces at serve-time.
- [x] ~~GDPR/CCPA account data export and deletion~~ — Done (SEC-003). `GET /api/auth/export` (JSON archive) and `DELETE /api/auth/account` (cascade hard-delete). Both require password confirmation.
