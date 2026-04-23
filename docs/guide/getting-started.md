# Getting Started

## Prerequisites

- **Node.js 20+**
- An API key for at least one AI provider — **or** a local [Ollama](https://ollama.com) installation (free, no key needed)
- Docker & Docker Compose (optional, for containerised deployment)

## Option A: Docker (Recommended)

```bash
git clone https://github.com/RameshBabuPrudhvi/sentri.git
cd sentri

cp backend/.env.example backend/.env
# Edit backend/.env — add at least one AI provider key

docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) (frontend) — backend runs on `:3001`.

### Optional services

Both Redis and PostgreSQL ship as **optional profiles** in `docker-compose.yml`. They are not required to try Sentri — SQLite + in-memory stores work fine for single-instance deployments.

```bash
# Redis only (rate limiting + BullMQ job queue + SSE pub/sub)
docker compose --profile redis up

# PostgreSQL only (horizontally scalable DB)
docker compose --profile postgres up

# Full stack — Redis + PostgreSQL
docker compose --profile redis --profile postgres up
```

Then uncomment the matching env vars in `backend/.env`:

```bash
DATABASE_URL=postgres://sentri:sentri@postgres:5432/sentri
REDIS_URL=redis://redis:6379
```

## Option B: Local Development

### Minimal setup

Runs everything in-process with SQLite — fastest path to trying Sentri.

**Backend**

```bash
cd backend
npm install                 # Installs deps including better-sqlite3 (native module — prebuilt binaries for most platforms)
npx playwright install chromium ffmpeg
cp .env.example .env        # Add at least one AI provider key
npm run dev                 # Starts on :3001, creates data/sentri.db automatically
```

::: tip Database
SQLite (`data/sentri.db`) is created automatically on first startup — no manual setup needed. If upgrading from a previous version that used `sentri-db.json`, data is auto-migrated on first run.
:::

**Frontend**

```bash
cd frontend
npm install
npm run dev                 # Starts on :3000, proxies /api to :3001
```

Open [http://localhost:3000](http://localhost:3000)

### Adding Redis + BullMQ (optional)

Redis unlocks **durable job queues** (crashes mid-run don't lose work), **shared rate limiting**, and **cross-instance SSE pub/sub**. Recommended once you start running long crawls or multiple concurrent runs.

Run Redis in Docker (simplest):

```bash
docker run -d --name sentri-redis -p 6379:6379 redis:7-alpine
```

Or via Homebrew on macOS:

```bash
brew install redis && redis-server
```

Install the optional npm packages and enable Redis in `backend/.env`:

```bash
cd backend
npm install ioredis rate-limit-redis bullmq
```

```bash
# backend/.env
REDIS_URL=redis://localhost:6379
MAX_WORKERS=2               # Concurrency limit for BullMQ run execution
```

Restart the backend. At boot you'll see:

```
[info] Redis connected (rate limiting + token revocation + SSE pub/sub enabled)
[info] [worker] BullMQ worker started (concurrency: 2)
```

::: tip BullMQ auto-detection
BullMQ activates automatically when `REDIS_URL` is set **and** `bullmq` is installed. If either is missing, Sentri silently falls back to in-process execution — no config change required.
:::

### Adding PostgreSQL (optional)

PostgreSQL replaces SQLite for horizontal scaling and better write-concurrency. Required for multi-instance deployments.

```bash
docker run -d --name sentri-postgres \
  -e POSTGRES_USER=sentri -e POSTGRES_PASSWORD=sentri -e POSTGRES_DB=sentri \
  -p 5432:5432 postgres:16-alpine
```

In `backend/.env`:

```bash
DATABASE_URL=postgres://sentri:sentri@localhost:5432/sentri
PG_POOL_SIZE=10
```

Sentri's migration runner auto-detects the dialect at startup and translates SQLite-specific SQL (AUTOINCREMENT, INSERT OR IGNORE, LIKE, datetime) to PostgreSQL equivalents.

### Adding Ollama (optional, free local AI)

No API key needed — inference runs on your machine.

```bash
# Install Ollama — https://ollama.com/download
ollama pull mistral:7b
ollama serve                # Runs on :11434 by default
```

In `backend/.env`:

```bash
AI_PROVIDER=local
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral:7b
```

::: warning Ollama is single-threaded
Only one LLM request can be in flight at a time. When a crawl/generate is running, the chat endpoint returns `503 AI is busy` until it finishes. This is by design — concurrent requests would hang the model.
:::

## First Steps

1. **Create a project** — click "New Project", enter your app's URL
2. **Crawl** — Sentri launches Chromium and discovers pages automatically
3. **Review** — generated tests land in a Draft queue. Approve the ones you want
4. **Run** — click "Run Regression" to execute all approved tests
5. **Monitor** — watch the live browser view, check the dashboard for pass rates

## Verify your setup

Quick health check from the terminal:

```bash
# Backend is up
curl http://localhost:3001/health

# Active AI provider + infra status
curl http://localhost:3001/api/v1/system
```

The `/api/v1/system` response includes `activeProvider`, `redis`, `postgres`, and `activeSchedules` so you can confirm optional services are wired up correctly.

## Next

- [What is Sentri?](/guide/what-is-sentri) — deeper overview
- [Architecture](/guide/architecture) — how the pipeline and runner are structured
- [AI Providers](/guide/ai-providers) — configure Anthropic, OpenAI, Google, or Ollama
- [Environment Variables](/guide/env-vars) — full reference for all backend + frontend env vars
- [Docker Deployment](/guide/docker) — production Docker setup
- [Production Checklist](/guide/production) — what to harden before exposing Sentri to a team
