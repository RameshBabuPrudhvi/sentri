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

Open [http://localhost:80](http://localhost:80)

## Option B: Local Development

### Backend

```bash
cd backend
npm install
npx playwright install chromium
cp .env.example .env        # Add at least one AI provider key
npm run dev                 # Starts on :3001
```

### Frontend

```bash
cd frontend
npm install
npm run dev                 # Starts on :3000, proxies /api to :3001
```

Open [http://localhost:3000](http://localhost:3000)

## First Steps

1. **Create a project** — click "New Project", enter your app's URL
2. **Crawl** — Sentri launches Chromium and discovers pages automatically
3. **Review** — generated tests land in a Draft queue. Approve the ones you want
4. **Run** — click "Run Regression" to execute all approved tests
5. **Monitor** — watch the live browser view, check the dashboard for pass rates

## Next

- [What is Sentri?](/guide/what-is-sentri) — deeper overview
- [AI Providers](/guide/ai-providers) — configure Anthropic, OpenAI, Google, or Ollama
- [Docker Deployment](/guide/docker) — production Docker setup
