# Vision-based locator healing

Vision healing extends DOM self-healing with two fallback stages:
1. **Pixelmatch** (deterministic, cheaper)
2. **LLM Vision** (only when enabled and needed)

## Project controls
Use project settings fields:
- `visionHealing`: `off` | `pixelmatch_only` | `pixelmatch_and_llm`
- `visionHealMaxCallsPerDay` (default `100`)
- `visionHealMaxCostUsdPerMonth` (default `$50`)

## Cost model
- Pixelmatch stage is CPU-only (no model token spend).
- LLM stage can consume token budget and should be gated with caps.

## Audit and telemetry
When wired end-to-end, each vision fallback should emit:
- `healing.vision_pixelmatch`
- `healing.vision_llm`
- `healing.vision_budget_exhausted`

Use `/api/v1/healing/summary` to monitor:
- `visionHealCount`
- `visionHealCostUsd`
- `visionHealStrategy`

## Incident disable
To disable quickly mid-incident:
1. Set `visionHealing` to `off` for impacted projects.
2. Keep runs active with DOM-only healing while investigating.
