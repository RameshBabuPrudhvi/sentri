# AI Providers

Sentri supports five built-in providers plus **OpenAI-compatible slots** for any vendor that speaks the OpenAI Chat Completions wire format (DeepSeek, Groq, Mistral, xAI, Azure OpenAI, Together, Fireworks, vLLM, LM Studio, LiteLLM, …). Switch at any time from the Settings page — no restart needed.

## Provider Comparison

| Provider | Model | Cost | Best For |
|---|---|---|---|
| Anthropic Claude | claude-sonnet-4-20250514 | Pay-as-you-go ($5 min) | Best quality output |
| OpenAI | gpt-4o-mini | Pay-as-you-go | Fast, high-volume crawls |
| Google Gemini | gemini-2.5-flash | Free tier (20 req/day) | Testing / evaluation |
| OpenRouter | openrouter/auto (configurable) | Pay-as-you-go | One key, 200+ models (Claude, GPT, Llama, Mixtral, …) |
| OpenAI-compatible (`compat:<id>`) | Any (you set baseUrl + model) | Vendor-dependent | DeepSeek, Groq, Mistral, xAI, vLLM, LiteLLM, … |
| Ollama | mistral:7b (configurable) | Free, local | Privacy, no API key needed |

**Auto-detection order:** Anthropic → OpenAI → Google → OpenRouter → any configured `compat:<id>` slot → Ollama

## Configuration

### Via Settings Page (Runtime)

Navigate to **Settings** in the app. Enter your API key for any cloud provider, or click "Activate Ollama" for local inference.

### Via Environment Variables (Persistent)

Add to `backend/.env`:

```bash
# Cloud providers (pick one or more)
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
GOOGLE_API_KEY=AIza...
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet   # any OpenRouter slug

# Local / Ollama (no key needed)
AI_PROVIDER=local
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral:7b
```

## Using OpenRouter (One Key, Many Models)

[OpenRouter](https://openrouter.ai) is a unified gateway to 200+ models behind a single OpenAI-compatible API. Useful when you want to A/B-test models or get fallback across vendors without juggling keys.

1. Get a key from [openrouter.ai/keys](https://openrouter.ai/keys)
2. In Sentri Settings, paste the key into the **OpenRouter** card — or set `OPENROUTER_API_KEY` in `.env`
3. (Optional) Pick a specific model via `OPENROUTER_MODEL`:
   - `openrouter/auto` (default — OpenRouter picks)
   - `anthropic/claude-3.5-sonnet`
   - `openai/gpt-4o-mini`
   - `meta-llama/llama-3.1-70b-instruct`
   - …see [openrouter.ai/models](https://openrouter.ai/models)

## Using OpenAI-Compatible Providers (DeepSeek, Groq, Mistral, vLLM, …)

Many vendors expose `/v1/chat/completions` with the OpenAI request/response schema. Sentri lets you register any of them as a **compat slot** keyed `compat:<id>` — no code change, no SDK install. Each slot stores its own `baseUrl`, `model`, `apiKey`, and `displayName`, gets its own circuit breaker, and participates in the [FEA-003 fallback chain](../changelog.md).

### Add a slot via the Settings page

Navigate to **Settings → OpenAI-compatible providers** and fill in:

| Field | Example | Notes |
|---|---|---|
| **Slot id** | `deepseek` | Lowercase, `[a-z0-9_-]+`. Becomes `compat:deepseek` internally. |
| **Display name** | `DeepSeek` | Shown in the provider badge / dropdown. Optional. |
| **Base URL** | `https://api.deepseek.com/v1` | Must be HTTPS public; SSRF-validated server-side. |
| **Model** | `deepseek-chat` | Vendor-specific model id. |
| **API key** | `sk-…` | ≥10 characters; stored AES-encrypted in the `api_keys` table. |

Click **Save compat provider**. The slot is activated immediately and joins the fallback chain on rate limits / 5xx errors.

### Common base URLs

| Vendor | Base URL | Sample model |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat`, `deepseek-reasoner` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Mistral | `https://api.mistral.ai/v1` | `mistral-large-latest` |
| xAI Grok | `https://api.x.ai/v1` | `grok-2-latest` |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| Fireworks | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` | Your deployment name |
| LiteLLM proxy | `http://litellm.internal:4000/v1` | Any model the proxy fronts |
| vLLM / LM Studio / LocalAI | `http://<host>:<port>/v1` | Whatever the server hosts |

### Add a slot via the API (Docker / K8s bootstrap)

Compat slots are **not** configurable through env vars (see the warning below). For headless deployments, bootstrap the slot once via the admin API after the server starts:

```bash
curl -X POST https://your-sentri/api/v1/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider":    "compat:deepseek",
    "displayName": "DeepSeek",
    "baseUrl":     "https://api.deepseek.com/v1",
    "model":       "deepseek-chat",
    "apiKey":      "sk-..."
  }'
```

The slot is persisted in the encrypted `api_keys` table and survives restarts. To delete:

```bash
curl -X DELETE https://your-sentri/api/v1/settings/compat:deepseek \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

::: warning No env-var configuration
Compat slots are **DB-only** — there is intentionally no `COMPAT_<ID>_API_KEY` env equivalent. If you need pure env-driven config, use **OpenRouter** (`OPENROUTER_API_KEY` + `OPENROUTER_MODEL=deepseek/deepseek-chat`) — OpenRouter fronts most of the same vendors and is fully env-configured.
:::

### Self-hosted / on-prem endpoints (vLLM, LiteLLM, LocalAI)

The SSRF guard blocks loopback (`127.0.0.1`), RFC1918 (`10.x`, `192.168.x`), link-local (`169.254.x`), and `localhost` base URLs at save time **and** re-validates on every call (DNS-rebinding mitigation). To run against an internal LLM server, set:

```bash
ALLOW_PRIVATE_URLS=true
```

in `backend/.env`. **This bypass is scoped exclusively to compat-slot saves and the per-call guarded fetch** — trigger callbacks, preview URLs (Playwright-navigated), and notification webhooks remain SSRF-protected. Do not enable in multi-tenant deployments where untrusted users can configure providers.

### Performance tuning

The decrypted compat config is cached in-memory with a 60 s TTL to avoid hitting SQLite + AES decryption on every AI call. Override the TTL via:

```bash
COMPAT_CONFIG_CACHE_TTL_MS=30000   # default 60000
```

When `REDIS_URL` is set, cache invalidations are broadcast to other Sentri instances over the `sentri:compat-config:invalidate` channel so credential updates are visible cluster-wide within one round-trip.

## Using Ollama (Free Local AI)

1. Install from [ollama.com](https://ollama.com)
2. Pull a model:
   ```bash
   ollama pull mistral:7b          # ~2 GB, good quality
   ollama pull qwen2.5-coder:7b  # great for code generation
   ollama pull mistral           # lighter alternative
   ```
3. Start the server: `ollama serve`
4. In Sentri Settings, select Ollama — or set `AI_PROVIDER=local` in `.env`

::: tip Recommended Models
For best results use a model with strong JSON output and code generation: **mistral:7b**, **qwen2.5-coder:7b**, or **mistral**. Small models (≤3B) may struggle to produce valid Playwright code.
:::
