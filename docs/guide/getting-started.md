# Getting Started

## Prerequisites

- **Node.js 20+**
- An API key for at least one AI provider — **or** a local [Ollama](https://ollama.com) installation (free, no key needed)
- Docker & Docker Compose (optional, for containerised deployment)

## Option A: Docker (Recommended)

Works identically on macOS, Linux, and Windows (Docker Desktop).

::: code-group
```bash [macOS / Linux]
git clone https://github.com/RameshBabuPrudhvi/sentri.git
cd sentri

cp backend/.env.example backend/.env
# Edit backend/.env — add at least one AI provider key

docker compose up --build
```

```powershell [Windows (PowerShell)]
git clone https://github.com/RameshBabuPrudhvi/sentri.git
cd sentri

Copy-Item backend\.env.example backend\.env
# Edit backend\.env — add at least one AI provider key

docker compose up --build
```
:::

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

::: code-group
```bash [macOS / Linux]
cd backend
npm install                 # Installs deps including better-sqlite3 (native module — prebuilt binaries for most platforms)
npx playwright install chromium ffmpeg
cp .env.example .env        # Add at least one AI provider key
npm run dev                 # Starts on :3001, creates data/sentri.db automatically
```

```powershell [Windows (PowerShell)]
cd backend
npm install                 # Installs deps including better-sqlite3 (native module — prebuilt binaries for most platforms)
npx playwright install chromium ffmpeg
Copy-Item .env.example .env # Add at least one AI provider key
npm run dev                 # Starts on :3001, creates data\sentri.db automatically
```
:::

::: tip Windows build tools
`better-sqlite3` ships prebuilt binaries for Windows x64 and arm64 — no compiler needed in most cases. If `npm install` tries to build from source, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload, then re-run.
:::

::: tip Database
SQLite (`data/sentri.db`) is created automatically on first startup — no manual setup needed. If upgrading from a previous version that used `sentri-db.json`, data is auto-migrated on first run.
:::

**Frontend**

::: code-group
```bash [macOS / Linux / Windows]
cd frontend
npm install
npm run dev                 # Starts on :3000, proxies /api to :3001
```
:::

Open [http://localhost:3000](http://localhost:3000)

### Adding Redis + BullMQ (optional)

Redis unlocks **durable job queues** (crashes mid-run don't lose work), **shared rate limiting**, and **cross-instance SSE pub/sub**. Recommended once you start running long crawls or multiple concurrent runs.

Install Redis natively:

::: code-group
```bash [macOS]
brew install redis
brew services start redis   # Or: redis-server (foreground)
```

```bash [Ubuntu / Debian]
sudo apt-get install redis-server
sudo systemctl enable --now redis-server
```

```powershell [Windows (WSL2)]
# Recommended — run Linux Redis inside Windows Subsystem for Linux.
wsl --install -d Ubuntu     # First-time WSL2 setup (reboot may be required)
wsl
# Then inside the WSL shell:
sudo apt-get update && sudo apt-get install -y redis-server
sudo service redis-server start
# Redis is now reachable from Windows at localhost:6379
```

```powershell [Windows (Memurai)]
# Native Windows alternative — Memurai is Redis-compatible.
# Download the free Developer Edition: https://www.memurai.com/get-memurai
# After install, Memurai runs as a Windows service on :6379 automatically.
Get-Service -Name Memurai   # Verify it's running
```
:::

Install the optional npm packages:

```bash
cd backend
npm install ioredis rate-limit-redis bullmq
```

Enable in `backend/.env`:

```bash
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

Install PostgreSQL 16 natively:

::: code-group
```bash [macOS]
brew install postgresql@16
brew services start postgresql@16
createdb sentri
```

```bash [Ubuntu / Debian]
sudo apt-get install postgresql-16
sudo systemctl enable --now postgresql
sudo -u postgres createdb sentri
sudo -u postgres psql -c "CREATE USER sentri WITH PASSWORD 'sentri';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE sentri TO sentri;"
```

```bash [Windows]
# Download the official installer from https://www.postgresql.org/download/windows/
# After install, open SQL Shell (psql) and run:
#   CREATE DATABASE sentri;
#   CREATE USER sentri WITH PASSWORD 'sentri';
#   GRANT ALL PRIVILEGES ON DATABASE sentri TO sentri;
```
:::

Enable in `backend/.env`:

```bash
DATABASE_URL=postgres://sentri:sentri@localhost:5432/sentri
PG_POOL_SIZE=10
```

Sentri's migration runner auto-detects the dialect at startup and translates SQLite-specific SQL (AUTOINCREMENT, INSERT OR IGNORE, LIKE, datetime) to PostgreSQL equivalents.

### Adding Ollama (optional, free local AI)

No API key needed — inference runs on your machine.

1. Install Ollama from [ollama.com/download](https://ollama.com/download) (native installers for macOS, Linux, Windows).
2. Pull a model and start the server:

```bash
ollama pull mistral:7b
ollama serve                # Runs on :11434 by default
```

3. Enable in `backend/.env`:

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

::: code-group
```bash [macOS / Linux]
# Backend is up
curl http://localhost:3001/health

# Active AI provider + infra status
curl http://localhost:3001/api/v1/system
```

```powershell [Windows (PowerShell)]
# Backend is up
Invoke-RestMethod http://localhost:3001/health

# Active AI provider + infra status
Invoke-RestMethod http://localhost:3001/api/v1/system
```
:::

The `/api/v1/system` response includes `activeProvider`, `redis`, `postgres`, and `activeSchedules` so you can confirm optional services are wired up correctly.

## Next

- [What is Sentri?](/guide/what-is-sentri) — deeper overview
- [Architecture](/guide/architecture) — how the pipeline and runner are structured
- [AI Providers](/guide/ai-providers) — configure Anthropic, OpenAI, Google, or Ollama
- [Environment Variables](/guide/env-vars) — full reference for all backend + frontend env vars
- [Docker Deployment](/guide/docker) — production Docker setup
- [Production Checklist](/guide/production) — what to harden before exposing Sentri to a team
