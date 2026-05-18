# Vision-based locator healing (MNT-001)

Vision healing extends Sentri's 6-stage DOM self-healing waterfall with two
host-side post-waterfall fallbacks that fire **only after** every DOM
strategy has failed. Customers see flake spikes after every release when a
UI refresh moves elements visually but rewrites every selector — vision
healing recovers from that class of failure.

## Architecture

```
runtime helper (vm sandbox) — stages 0–6
   getByRole → getByLabel → getByText → aria-label → title → CSS/XPath
                          ↓ (all DOM strategies fail)
host (Node) — stages 7–8
   tryVisionHeal({ testId, action, label, project, failureScreenshot, baselineCrop })
     ↓
     stage 7  pixelmatch CV     — free, deterministic
     stage 8  LLM vision call   — paid, only when stage 7 declines + budget
                                  allows + project is set to pixelmatch_and_llm
```

Stages 7-8 live in `backend/src/selfHealing.js#tryVisionHeal` (host-side)
rather than in the injected runtime helper code because they need Node-side
libraries (pixelmatch + PNG decoder), the production `aiProvider`
multimodal abstraction, and the SQLite-backed budget circuit-breaker —
none of which can be serialised into the runtime string template.

`STRATEGY_VERSION` is bumped from 3 → 4 in this release. Existing healing
hints are invalidated automatically (their `strategyVersion` field no longer
matches), so the first run after deploy retraverses the full waterfall to
re-learn the winning strategy per element. This is the safe migration path —
versioning a hint against the new strategy space prevents stale hints
pointing at the wrong stage index.

## Project controls

Per-project columns on the `projects` table (migration `035`):

| Field                            | Type    | Default | Purpose                                                         |
|----------------------------------|---------|---------|-----------------------------------------------------------------|
| `visionHealing`                  | TEXT    | `"off"` | `off` / `pixelmatch_only` / `pixelmatch_and_llm`                |
| `visionHealMaxCallsPerDay`       | INTEGER | `100`   | Daily cap on stage-8 (LLM) calls. Stage 7 keeps running.        |
| `visionHealMaxCostUsdPerMonth`   | REAL    | `50`    | Monthly USD cap on stage-8 spend. Stage 7 keeps running.        |

Configured via the **Vision Healing** tab in the Quality card per project
(`frontend/src/components/automation/ProjectQualityCard.jsx`). PATCHes to
`/api/v1/projects/:id` accept these fields as a single-field bypass — same
pattern as `strictPiiFirewall` (SEC-006) and `autoApproveThreshold` (AUTO-003b).

The `pixelmatch_and_llm` option is server-gated: the route validator calls
`aiProvider.hasVisionProvider()` and returns
`{ error: "VISION_PROVIDER_NOT_CONFIGURED" }` (HTTP 400) when no
vision-capable LLM is configured. The UI surfaces that as a disabled radio
button with a tooltip ("VISION_MODEL not configured server-side"); a
maintainer set `VISION_MODEL` or pick a vision-capable `AI_MODEL` to enable.

### Vision-capable models

The provider abstraction (`aiProvider.resolveVisionModel`) maintains a
whitelist of model IDs that natively accept image inputs:

- **Anthropic**: `claude-3-5-sonnet-20241022`, `claude-3-5-sonnet-20240620`,
  `claude-3-opus-20240229`, `claude-sonnet-4-20250514`
- **OpenAI**: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-4-vision-preview`
- **Google Gemini**: `gemini-1.5-pro`, `gemini-1.5-flash`, `gemini-2.5-flash`

An explicit `VISION_MODEL` env var bypasses the whitelist (operator opt-in
for a custom / self-hosted vision model).

## Cost model

| Stage             | Per-call cost | Notes                                                                  |
|-------------------|---------------|------------------------------------------------------------------------|
| Stage 7 pixelmatch | $0 / call    | Pure CPU. Adds 50–200 ms per heal attempt on the host process.         |
| Stage 8 LLM       | $0.001–$0.03 | Model-dependent. Includes one image upload (~50 KB base64) + ~200 tokens out. |

Cost estimate from `aiProvider.callVisionModel` uses a $5/M input +
$15/M output midpoint (rough Claude Sonnet / GPT-4o midrange). Proper
per-model pricing lands in MNT-001b — the budget circuit-breaker only
needs *some* signal, not byte-accurate accounting.

## Budget circuit-breaker

`tryVisionHeal` consults an injected `isBudgetExhausted(projectId)` helper
before every stage-8 call. When either flag is true:

- `dailyCalls: true` — soft-disable stage 8 for the rest of the UTC day.
- `monthlyCost: true` — soft-disable stage 8 for the rest of the calendar month.

Stage 7 (pixelmatch) keeps running in either case — it's free.

When the budget check itself throws (DB blip, repo down), the conservative
path is taken: **no LLM call** for that test. A passing test stays passing;
a failing test stays failing.

## Audit and telemetry

Every vision heal emits exactly one event into the run's `__healingEvents`
stream alongside the existing DOM-strategy events. `persistHealingEvents`
in `backend/src/runner/healingPersistence.js` routes them to:

- `healing.vision_pixelmatch` — stage 7 succeeded
- `healing.vision_llm` — stage 8 succeeded
- `healing.vision_budget_exhausted` — stage 8 skipped due to budget cap

Aggregate counters surface on `GET /api/v1/healing/summary`:

```json
{
  "visionHealCount": 12,
  "visionHealCostUsd": 0.045,
  "visionHealStrategy": { "pixelmatch": 9, "llm": 3 }
}
```

Rendered by the Healing dashboard's `VisionHealPanel` (zero-state safe:
renders `0` / `$0.00` with no errors before any vision heal has occurred).

## Adaptive learning

Successful vision heals call the standard `recordHealing(testId, action,
label, 7 | 8)` so the existing `getHealingHint()` machinery promotes the
winning strategy on the next run. Indices 7 and 8 are reserved via:

```js
export const STRATEGY_INDEX_PIXELMATCH = 7;
export const STRATEGY_INDEX_LLM_VISION = 8;
export const VISION_STRATEGY_INDICES = Object.freeze([7, 8]);
```

The runtime helper waterfall in `getSelfHealingHelperCode` still only emits
indices 0–6; hints at 7/8 only fire the host-side `tryVisionHeal` path.

## Baseline crop capture

Stage 7 (pixelmatch) needs a baseline element thumbnail to slide-match
against the failure screenshot. The helper lives in
`backend/src/runner/pageCapture.js#captureElementCrop`:

```js
import { captureElementCrop } from "./pageCapture.js";
const buf = await captureElementCrop(page, locator);
// buf is a PNG buffer, or null on any failure
```

Best-effort: returns `null` when the locator is hidden, off-screen, or
mid-detach. Persistence to the baseline repo and the wiring of green-run
captures is **deferred to MNT-001b** — this release ships the helper and
the consumer surface in `tryVisionHeal({ baselineCrop })`.

## Incident disable

To disable quickly mid-incident:

1. **Per-project** — set `visionHealing: "off"` via the Vision Healing
   tab in Quality settings, or `PATCH /api/v1/projects/:id {visionHealing:"off"}`.
   Existing runs unaffected; new runs skip stages 7-8.
2. **Per-deployment** — unset `VISION_MODEL` (and ensure `AI_MODEL` is
   not vision-capable) so `hasVisionProvider()` returns false. Existing
   `pixelmatch_and_llm` projects are auto-downgraded to `pixelmatch_only`
   on the next save; in-flight LLM calls return `null` (no heal).
3. **Cost runaway** — drop `visionHealMaxCallsPerDay` to `1` or
   `visionHealMaxCostUsdPerMonth` to `0`. Stage 8 soft-disables within
   one heal attempt; stage 7 keeps running.

## What's deferred to MNT-001b

This PR ships the integration surface, the configuration plane, the
host-side waterfall entrypoint, and the multimodal provider abstraction.
The follow-up PR (`MNT-001b`) lands:

- Full sliding-window pixelmatch CV implementation
- Baseline crop persistence + green-run capture lifecycle
- SQLite-backed budget counter (`isBudgetExhausted` real impl)
- Re-action against the discovered bbox (currently `tryVisionHeal` returns
  the box; the runtime then needs a coordinate-click path)
- Audit-log event emission via `activityLogger`
- Healing dashboard sparkline (currently shows zero-state count/cost)

Until `MNT-001b` lands, projects can opt into the config without any
behavioural change: with no `pixelmatchHeal` / `llmVisionHeal` deps wired
in `executeTest.js`, `tryVisionHeal` returns `null` and tests stay marked
broken (existing behaviour).
