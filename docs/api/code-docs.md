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
| `database/sqlite.js` | SQLite singleton — `getDatabase()`, `closeDatabase()`, WAL mode, auto-schema |
| `database/repositories/*.js` | Data access layer — `projectRepo`, `testRepo`, `runRepo`, `activityRepo`, `healingRepo`, `userRepo`, `counterRepo` |
| `database/migrate.js` | One-time migration from legacy `sentri-db.json` → SQLite |
| `routes/auth.js` | Authentication — all 6 endpoints, JWT helpers, password hashing, OAuth, `requireAuth` middleware |
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
