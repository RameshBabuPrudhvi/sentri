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
- **Database:** In-memory JSON with periodic disk persistence (swap for PostgreSQL in production)
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
       │ In-memory DB     │ ← JSON persistence
       └─────────────────┘
```

## Key Design Decisions

| Decision | Rationale |
|---|---|
| In-memory DB | Zero setup for local dev. Swap for PostgreSQL via `db.js` interface |
| SSE over WebSocket | Simpler server implementation, auto-reconnect built into `EventSource` |
| Custom JWT (no library) | Zero dependencies. Uses Node.js `crypto` module only |
| Multi-provider AI | Avoid vendor lock-in. All providers implement the same interface |
| Human-readable IDs | `TC-1`, `RUN-2` instead of UUIDs — better for logs and conversation |
