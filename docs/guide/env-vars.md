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
