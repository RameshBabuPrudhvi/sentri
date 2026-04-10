# Docker Deployment

## Quick Start

```bash
git clone https://github.com/RameshBabuPrudhvi/sentri.git
cd sentri
cp backend/.env.example backend/.env
# Edit backend/.env — add at least one AI provider key
docker compose up --build
```

Open [http://localhost:80](http://localhost:80)

## Architecture

```
┌──────────────────┐     ┌──────────────────┐
│  frontend (nginx) │────▶│  backend (node)   │
│  :80              │     │  :3001            │
│  Serves SPA       │     │  Express API      │
│  Proxies /api/*   │     │  Playwright       │
└──────────────────┘     └──────────────────┘
```

Nginx proxies `/api/*` and `/artifacts/*` to the backend container automatically.

## Environment Variables

Set in `backend/.env` or pass via `docker compose`:

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
JWT_SECRET=your-32-char-secret
NODE_ENV=production
```

## Production Compose

For pre-built images from GHCR:

```bash
BACKEND_IMAGE=ghcr.io/you/sentri-backend:latest \
FRONTEND_IMAGE=ghcr.io/you/sentri-frontend:latest \
docker compose -f docker-compose.prod.yml up -d
```

## Volumes

The backend stores data in `/app/data/sentri.db` (SQLite) inside the container. Mount a volume to persist across restarts:

```yaml
volumes:
  - ./data:/app/data
```

::: tip Migration from JSON
If you have an existing `sentri-db.json` file in the data directory, it will be automatically migrated to SQLite on first startup and renamed to `sentri-db.json.migrated`.
:::
