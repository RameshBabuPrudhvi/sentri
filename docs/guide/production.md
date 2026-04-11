# Production Checklist

## Required

- [ ] Set `NODE_ENV=production`
- [ ] Set `JWT_SECRET` to a random 32+ char string (`openssl rand -base64 48`)
- [ ] Configure at least one AI provider key
- [ ] Set `VITE_API_URL` at frontend build time (for cross-origin deploys)

## Recommended

- [x] ~~Replace in-memory `db.js` with SQLite~~ — Done (better-sqlite3 with WAL mode, auto-migration from legacy JSON)
- [x] ~~Move JWT from localStorage to HttpOnly cookies~~ — Done (HttpOnly; Secure; SameSite=Strict cookie + CSRF double-submit protection)
- [ ] Add BullMQ + Redis for background crawl/run jobs with retries
- [ ] Store videos and screenshots to S3/R2 instead of local disk
- [ ] Restrict CORS origins in `backend/src/middleware/appSetup.js`
- [ ] Add cron-based auto-runs via `node-cron`
- [ ] Send Slack/email alerts on test failures
- [ ] Add workspace/organisation scoping for multi-tenancy
- [ ] Expose a run trigger webhook for CI/CD integration

## Security

- [x] OAuth state parameter validated
- [x] JWT secret throws in production if missing
- [x] Rate limiting on sign-in (10/IP/15min)
- [x] Passwords hashed with scrypt
- [x] JWT in HttpOnly; Secure; SameSite=Strict cookie (never in localStorage)
- [x] CSRF double-submit cookie on all mutating endpoints
- [x] No sensitive data in API responses (JWT never in response body)
- [ ] CORS restricted to your frontend domain (manual — set `CORS_ORIGIN` env var)
