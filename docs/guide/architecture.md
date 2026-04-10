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
- **Database:** SQLite (better-sqlite3) with WAL mode — auto-migrates from legacy JSON on first startup
- **Auth:** Custom JWT (HS256) with scrypt password hashing

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
       │ SQLite DB        │ ← WAL mode, data/sentri.db
       └─────────────────┘
```

## Key Design Decisions

| Decision | Rationale |
|---|---|
| SQLite (better-sqlite3) | Zero-config embedded database. WAL mode for concurrent reads. Repository pattern (`database/repositories/`) for all access. Auto-migrates legacy `sentri-db.json` on first startup |
| SSE over WebSocket | Simpler server implementation, auto-reconnect built into `EventSource` |
| Custom JWT (no library) | Zero dependencies. Uses Node.js `crypto` module only |
| Multi-provider AI | Avoid vendor lock-in. All providers implement the same interface |
| Human-readable IDs | `TC-1`, `RUN-2` instead of UUIDs — better for logs and conversation |
