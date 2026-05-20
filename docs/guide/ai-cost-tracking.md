# AI cost tracking (AI-003)

Sentri records the USD cost of every LLM call in a Prometheus counter so
operators can answer two questions without reading vendor invoices:

1. **What is cost-per-customer this month?**
   `sum by (workspaceId) (increase(app_ai_cost_usd_total[30d]))` /
   workspace count.
2. **Which provider / model is driving spend?**
   `sum by (provider, operation) (increase(app_ai_cost_usd_total[24h]))`.

## How it works

Pricing lives in **one file**: `backend/src/aiProvider/modelCatalog.js`,
under the `MODEL_PRICING` constant. Every entry follows the shape:

```js
"claude-sonnet-4-20250514": {
  provider:    "anthropic",
  inputPer1k:  0.003,   // USD per 1k input tokens
  outputPer1k: 0.015,   // USD per 1k output tokens
  asOf:        "2026-04-01",  // ISO date pricing was last verified
},
```

When a provider adapter (Anthropic / OpenAI / Google / Ollama) receives a
response from its SDK, it looks up the model in this table via
`computeCostUsd(model, usage)` and attaches the result to the usage
block as `costUsd`. The orchestrator then bumps
`app_ai_cost_usd_total{provider, operation}` by that value.

## Updating pricing when a vendor publishes new rates

When a vendor publishes new prices (or you find a stale entry):

1. Edit the entry in `backend/src/aiProvider/modelCatalog.js`.
2. **Bump the `asOf` field** to today's date (ISO `YYYY-MM-DD`).
3. Open a PR titled `chore(pricing): refresh <provider> rates`.
4. The CI `ai-provider-cost-tracking.test.js` test pins arithmetic for the
   reference models — update any test assertions that the rate change
   broke, with an explicit comment citing the vendor source URL.

That's it. No code changes are required outside the table.

## The `asOf` field and staleness

`asOf` is **informational** — the cost counter still emits using the
recorded values regardless of how old the entry is. A future staleness
alert (planned for AI-007) will fire when any active model in
`MODEL_PRICING` has an `asOf` older than 90 days, prompting an operator
to refresh.

## Catalog misses (`costUsd: null`)

When a model isn't in `MODEL_PRICING` (typical for compat slots pointing
at exotic OpenAI-compatible endpoints, or `openrouter/auto`), adapters
emit `usage.costUsd: null`. The orchestrator **skips** the counter
increment for null values — dashboards see "no data" rather than a fake
zero. This matters: averaging a fake `$0` across a workspace with
hundreds of calls would silently understate spend by 100%.

To add pricing for a missing model:

1. Find the vendor's published per-token rate.
2. Convert to per-1k tokens if the vendor quotes per-million.
3. Add the entry to `MODEL_PRICING`.
4. Add a test assertion in `backend/tests/ai-provider-cost-tracking.test.js`
   pinning the arithmetic.

## Known-free models (Ollama)

Local Ollama models are listed explicitly in the catalog with
`inputPer1k: 0, outputPer1k: 0`. This lets the dashboard render "$0.00"
for these models instead of "no data" — distinguishing **known free**
from **unknown** is a non-trivial dashboard requirement.

When you add a new local model to a deployment, add it to `MODEL_PRICING`
with `0/0` rates so it shows up correctly.

## Vision-heal fallback

The MNT-001 stage-8 vision-heal path retains its `$5/M input + $15/M output`
midpoint estimate as a **fallback** when the resolved vision model isn't in
the catalog. The fallback ensures the budget circuit-breaker
(`visionHealMaxCostUsdPerMonth`) always has *some* signal to enforce caps,
even when an operator brings their own vision model that hasn't been priced
in the table.

When the vision model **is** in the catalog, the catalog price wins — the
vision-heal cost tracks the same per-model pricing as test generation.

## Dashboards

Recommended PromQL queries (drop into Grafana):

```promql
# Daily spend per provider (USD)
sum by (provider) (increase(app_ai_cost_usd_total[1d]))

# Per-operation breakdown
sum by (provider, operation) (rate(app_ai_cost_usd_total[5m])) * 86400

# Vision-heal vs. generation share
sum by (operation) (increase(app_ai_cost_usd_total[24h]))
```

See `monitoring/prometheus/alerts.yml` for the
`VisionHealBudgetExhausted` alert that fires on per-project spend caps.

## Future work (AI-007)

AI-003 only **emits the signal**. The follow-up AI-007 (cost governance)
will:

- Add per-workspace monthly USD caps.
- Wire the cap into the orchestrator's circuit breaker so a workspace
  blowing its budget is paused (with an admin override).
- Add a kill switch (`AI_PROVIDER_DISABLED=true`) for incident response.

The cost counter is the load-bearing input for all three; this guide
documents the input surface.
