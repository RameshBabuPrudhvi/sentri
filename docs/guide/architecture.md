# Architecture

## Overview

Sentri is a monorepo with three main components:

```
sentri/
├── frontend/          # React + Vite SPA
├── backend/           # Express + Node.js API
├── docs/              # VitePress documentation (this site)
├── docker-compose.yml # Full-stack Docker setup
└── .github/workflows/ # CI/CD pipelines
```

## Frontend

- **Framework:** React 18 with Vite
- **Routing:** React Router v7
- **State:** React Context (AuthContext) + custom hooks with TTL cache
- **Real-time:** Server-Sent Events (SSE) with auto-reconnect
- **Charts:** Recharts
- **Icons:** Lucide React

## Backend

- **Runtime:** Node.js 20+
- **Framework:** Express
- **Browser Automation:** Playwright (Chromium)
- **AI Integration:** Anthropic SDK, OpenAI SDK, Google Generative AI, Ollama (HTTP)
- **Database:** SQLite (default, better-sqlite3 with WAL mode) or PostgreSQL (via `pg` + `pg-native`) — set `DATABASE_URL=postgres://…` to switch. Adapter pattern ensures all repository modules work unchanged on either backend. Auto-migrates from legacy JSON on first startup.
- **Redis:** Optional (`REDIS_URL`) — enables shared rate limiting (`rate-limit-redis`), cross-instance token revocation (pub/sub), and SSE event relay between server instances. Falls back to in-memory stores when not configured.
- **Auth:** Custom JWT (HS256) with scrypt password hashing, email verification on registration

## Data Flow

```
User → Frontend (React SPA)
         ↓ fetch / SSE
       Backend (Express API)
         ↓
       ┌─────────────────┐
       │ Playwright       │ ← browser automation
       │ AI Provider      │ ← test generation
       │ Self-Healing     │ ← selector waterfall
       │ SQLite / PG      │ ← WAL mode or connection pool
       │ Redis (optional) │ ← rate limits, revocation, SSE relay
       └─────────────────┘
```

## Key Design Decisions

| Decision | Rationale |
|---|---|
| SQLite default + PostgreSQL option | SQLite is zero-config for local dev. PostgreSQL (`DATABASE_URL`) for production scaling. Both use the same adapter interface (`prepare`/`exec`/`transaction`) so repository modules work unchanged. Dialect-aware migration runner translates SQLite SQL to PostgreSQL automatically |
| Redis optional | In-memory stores work for single-instance. Set `REDIS_URL` for multi-instance: shared rate limits (`rate-limit-redis`), cross-instance token revocation (pub/sub), SSE event relay. Falls back gracefully when not configured |
| SSE over WebSocket | Simpler server implementation, auto-reconnect built into `EventSource`. Redis pub/sub relays events across instances |
| Custom JWT (no library) | Zero dependencies. Uses Node.js `crypto` module only |
| Multi-provider AI | Avoid vendor lock-in. All providers implement the same interface |
| Human-readable IDs | `TC-1`, `RUN-2` instead of UUIDs — better for logs and conversation |
