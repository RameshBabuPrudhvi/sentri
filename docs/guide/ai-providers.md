# AI Providers

Sentri supports four AI providers. Switch at any time from the Settings page — no restart needed.

## Provider Comparison

| Provider | Model | Cost | Best For |
|---|---|---|---|
| Anthropic Claude | claude-sonnet-4-20250514 | Pay-as-you-go ($5 min) | Best quality output |
| OpenAI | gpt-4o-mini | Pay-as-you-go | Fast, high-volume crawls |
| Google Gemini | gemini-2.5-flash | Free tier (20 req/day) | Testing / evaluation |
| Ollama | mistral:7b (configurable) | Free, local | Privacy, no API key needed |

**Auto-detection order:** Anthropic → OpenAI → Google → Ollama

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

# Local / Ollama (no key needed)
AI_PROVIDER=local
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral:7b
```

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
