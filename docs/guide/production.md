# Production Checklist

## Required

- [ ] Set `NODE_ENV=production`
- [ ] Set `JWT_SECRET` to a random 32+ char string (`openssl rand -base64 48`)
- [ ] Configure at least one AI provider key
- [ ] Set `VITE_API_URL` at frontend build time (for cross-origin deploys)

## Recommended

- [ ] Replace in-memory `db.js` with PostgreSQL + Prisma ORM
- [ ] Add BullMQ + Redis for background crawl/run jobs with retries
- [ ] Store videos and screenshots to S3/R2 instead of local disk
- [ ] Restrict CORS origins in `backend/src/middleware/appSetup.js`
- [ ] Move JWT from localStorage to HttpOnly cookies
- [ ] Add cron-based auto-runs via `node-cron`
- [ ] Send Slack/email alerts on test failures
- [ ] Add workspace/organisation scoping for multi-tenancy
- [ ] Expose a run trigger webhook for CI/CD integration

## Security

- [ ] OAuth state parameter is validated (already implemented)
- [ ] JWT secret throws in production if missing (already implemented)
- [ ] Rate limiting on sign-in (already implemented — 10/IP/15min)
- [ ] Passwords hashed with scrypt (already implemented)
- [ ] No sensitive data in API responses (already implemented)
- [ ] CORS restricted to your frontend domain (manual — update `appSetup.js`)
