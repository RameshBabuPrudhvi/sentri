# Environment Variables

## Backend (`backend/.env`)

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | auto-detect | Force: `anthropic`, `openai`, `google`, or `local` |
| `ANTHROPIC_API_KEY` | — | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | — | [platform.openai.com](https://platform.openai.com/api-keys) |
| `GOOGLE_API_KEY` | — | [aistudio.google.com](https://aistudio.google.com/apikey) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Model name for local inference |
| `OLLAMA_MAX_PREDICT` | `4096` | Max token output cap |
| `OLLAMA_TIMEOUT_MS` | `120000` | Timeout for Ollama calls |
| `JWT_SECRET` | random (dev) | **Required in production.** 32+ char secret for signing JWTs |
| `NODE_ENV` | — | Set to `production` for production deployments |
| `PORT` | `3001` | Backend server port |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `LOG_JSON` | `false` | Emit structured JSON logs |

## Test Execution

| Variable | Default | Description |
|---|---|---|
| `BROWSER_HEADLESS` | `true` | Set `false` to see the browser window during test runs |
| `VIEWPORT_WIDTH` | `1280` | Browser viewport width (px) |
| `VIEWPORT_HEIGHT` | `720` | Browser viewport height (px) |
| `NAVIGATION_TIMEOUT` | `30000` | Timeout for `page.goto()` calls (ms) |
| `PARALLEL_WORKERS` | `1` | Default number of tests to run concurrently (1–10). Override per-run from the ⚡ selector in the UI or via `parallelWorkers` in the API `dialsConfig`. Each worker uses an isolated `BrowserContext` within a shared Chromium process |

## Crawler

| Variable | Default | Description |
|---|---|---|
| `CRAWL_MAX_PAGES` | `30` | Maximum pages to visit per crawl |
| `CRAWL_MAX_DEPTH` | `3` | Maximum link-follow depth from the start URL |
| `CRAWL_NETWORKIDLE_TIMEOUT` | `5000` | Timeout (ms) for networkidle wait after page load |

## Self-Healing

| Variable | Default | Description |
|---|---|---|
| `HEALING_ELEMENT_TIMEOUT` | `5000` | Element finding timeout per strategy in the waterfall (ms) |
| `HEALING_RETRY_COUNT` | `3` | Retries per interaction before giving up |
| `HEALING_RETRY_DELAY` | `400` | Pause between retries (ms) |

## Frontend (build-time)

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `""` (same origin) | Backend URL for cross-origin deploys |
| `GITHUB_PAGES` | — | Set to `true` to use `/sentri/` base path |
| `VITE_GITHUB_CLIENT_ID` | — | GitHub OAuth client ID |
| `VITE_GOOGLE_CLIENT_ID` | — | Google OAuth client ID |

## OAuth (backend)

| Variable | Description |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Override Google OAuth redirect URI |
