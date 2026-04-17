# Code Documentation (JSDoc)

Auto-generated documentation for every module, function, and type in the codebase.

<a href="/sentri/docs/jsdoc/index.html" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:10px 20px;background:#6366f1;color:#fff;border-radius:8px;font-weight:600;text-decoration:none;margin:16px 0">
  Open Code Docs ↗
</a>

## What's Documented

### Backend (`backend/src/`)

| Module | Description |
|---|---|
| `db.js` | SQLite compatibility shim — `getDb()` returns snapshot, `saveDb()` is no-op |
| `database/sqlite.js` | Database singleton — `getDatabase()`, `closeDatabase()`, `getDatabaseDialect()`. Detects SQLite vs PostgreSQL from `DATABASE_URL` |
| `database/adapters/sqlite-adapter.js` | SQLite adapter — WAL mode, better-sqlite3 wrapper |
| `database/adapters/postgres-adapter.js` | PostgreSQL adapter — pg-native/deasync, SQL dialect translation, `AsyncLocalStorage` transactions |
| `database/migrationRunner.js` | Versioned, dialect-aware migration runner with checksum validation |
| `database/repositories/*.js` | Data access layer — `projectRepo`, `testRepo`, `runRepo`, `activityRepo`, `healingRepo`, `userRepo`, `counterRepo`, `verificationTokenRepo`, `passwordResetTokenRepo`, `webhookTokenRepo`, `scheduleRepo` |
| `database/migrate.js` | One-time migration from legacy `sentri-db.json` → SQLite |
| `utils/redisClient.js` | Shared Redis client — `redis`, `redisSub`, `isRedisAvailable()`, `closeRedis()` |
| `utils/emailSender.js` | Transactional email — `sendEmail()`, `sendVerificationEmail()`, Resend/SMTP/console transport |
| `routes/auth.js` | Authentication — 10 endpoints (register, login, logout, refresh, me, verify, resend-verification, forgot-password, reset-password, OAuth), JWT helpers, password hashing |
| `middleware/authenticate.js` | Strategy-based auth — JWT cookie/bearer/query + trigger token, token revocation with Redis pub/sub |
| `crawler.js` | Chromium-based page crawler |
| `testRunner.js` | Playwright test execution engine |
| `selfHealing.js` | Multi-strategy selector waterfall with healing history |
| `aiProvider.js` | Multi-provider AI abstraction (Anthropic, OpenAI, Google, Ollama) |
| `testDials.js` | Test generation configuration and prompt builder |

### Frontend (`frontend/src/`)

| Module | Description |
|---|---|
| `api.js` | Centralised API client — every `api.*` method documented with params/returns |
| `utils/api.js` | `API_BASE` constant and `parseJsonResponse` helper |
| `context/AuthContext.jsx` | `AuthProvider`, `useAuth()` hook, `login()`, `logout()`, `authFetch()` |

## Regenerating Locally

```bash
cd backend
npm run docs          # generates backend/docs-api/
open docs-api/index.html
```

The CI pipeline regenerates these automatically on every push to `main`.
