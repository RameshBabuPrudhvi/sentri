# AI Eval Harness (AUTO-022)

The eval harness is Sentri's safety net against silent regressions in
test-generation quality. Every PR that touches the AI pipeline, the
provider abstraction, or a prompt template runs the harness against a
frozen golden set and fails CI if the aggregate score drops more than
5% versus the last baseline.

## How it works

```
┌────────────────────┐    snapshot     ┌──────────────────────────┐
│ case-NNN.json      │ ───────────────▶│  generateAllTests        │
│  { snapshot,       │                 │  → runPostGenerationPipeline
│    expected }      │                 │  (production code path)  │
└────────────────────┘                 └────────────┬─────────────┘
                                                    │ actual code
                                                    ▼
                                       ┌──────────────────────────┐
                                       │ pipelineEval.scoreCase   │
                                       │  Levenshtein per dim:    │
                                       │    selectors / actions / │
                                       │    assertions            │
                                       └────────────┬─────────────┘
                                                    │ per-case score
                                                    ▼
                                       ┌──────────────────────────┐
                                       │ aggregate vs              │
                                       │ eval-baseline.json        │
                                       │ → exit 0 / 1              │
                                       └──────────────────────────┘
```

Key invariants:

- **Pure scorer.** `backend/src/eval/pipelineEval.js` never calls the
  LLM. It receives an `actual` string from an injected adapter, parses
  selectors / actions / assertions, and scores via length-normalised
  Levenshtein distance. Unit-testable in isolation.
- **Record / replay separation.** Live LLM calls only happen in dev
  with `EVAL_RECORD=1`. CI runs in replay mode against committed cache
  entries, so the build is deterministic and offline.
- **Hand-rolled baseline.** `eval-baseline.json` lives at the repo
  root and is bumped by a deliberate `chore(eval):` PR after an
  intentional prompt / model change — never auto-bumped on every run.

## File layout

```
backend/src/eval/
├── pipelineAdapter.js   record/replay adapters + production pipeline binding
└── pipelineEval.js      pure scorer (levenshtein, parseTuples, scoreCase, runEval)

backend/scripts/
└── run-eval.mjs         CI entrypoint: --write-baseline, --report=, --persist, EVAL_RECORD=1

backend/tests/
├── eval-pipeline.test.js              17 unit tests covering the scorer
└── fixtures/eval-goldens/
    ├── case-001.json … case-NNN.json  frozen { snapshot, expected } cases
    ├── snapshots/                      large DOMs referenced via @file:
    └── .cache/                         git-ignored LLM response cache

.github/workflows/eval.yml              path-filtered CI job
eval-baseline.json                       last-known-good aggregate score
```

## Golden case schema

```json
{
  "id": "case-001",
  "category": "form-fill | list-click | modal | multi-page-nav | assertion-heavy",
  "description": "One-line human summary",
  "url": "https://example.com/some/page",
  "snapshot": "<html>…</html>",
  "expected": "await page.getByRole(...).click();\nawait expect(...).toBeVisible();"
}
```

For DOM snapshots larger than ~5 KB, drop the HTML in
`backend/tests/fixtures/eval-goldens/snapshots/<id>.html` and reference
it via `"snapshot": "@file:snapshots/<id>.html"`. The loader in
`pipelineEval.js#resolveSnapshot` inlines it transparently.

### Target distribution — 50 cases total

| Category          | Target | Covers                                               |
|-------------------|--------|------------------------------------------------------|
| `form-fill`       | 10     | Inputs + submit + success indicator                  |
| `list-click`      | 10     | List/grid row click → detail view                    |
| `modal`           | 10     | Open / confirm / dismiss dialogs                     |
| `multi-page-nav`  | 10     | Login flow, navigation across routes                 |
| `assertion-heavy` | 10     | Success-page rendering with multiple post-conditions |

Cases 1–5 are the canonical templates. The remaining 45 are tracked as
**AUTO-022 follow-up** and need real DOM captures from
`tests/e2e/specs/`, not synthetic snapshots.

## Inspect a regression

When CI fails on the `eval` job:

1. Open the job log. Look for:
   ```
   FAIL — regression vs baseline: 8.42% (threshold 5.00%)
   affected cases (per-case aggregate drop > 20.00%):
     - case-017: 88.00% → 40.00% (-48.00%)
     - case-029: 95.00% → 50.00% (-45.00%)
   ```
2. Download the `eval-report.json` workflow artifact for per-case
   `expected` vs `actual` diffs.
3. Reproduce locally:
   ```bash
   EVAL_RECORD=1 node backend/scripts/run-eval.mjs --report=/tmp/eval.json
   ```
4. Decide:
   - The pipeline genuinely regressed → fix the prompt / model / pipeline
     change and re-record.
   - The change is intentional and improves output (golden is now
     out-of-date) → rebaseline (see below).

## Add a new golden

1. Pick a target flow from `tests/e2e/specs/` or run the app locally.
2. Capture the DOM at the relevant interaction point:
   ```js
   const html = await page.content();
   ```
3. Save as the next free `case-NNN.json` in
   `backend/tests/fixtures/eval-goldens/` matching the schema above.
4. Run the harness in record mode:
   ```bash
   EVAL_RECORD=1 node backend/scripts/run-eval.mjs
   ```
   This invokes the production pipeline with your snapshot, writes the
   generated Playwright code to `.cache/<id>.<hash>.txt`, and scores it
   against your `expected` field.
5. Inspect the score. If `expected` realistically matches what the
   pipeline emits, score should be ≥ 0.7. If it's lower, either fix
   your `expected` field or accept that the pipeline produces a
   different (but valid) phrasing — both are useful signals.
6. Commit the JSON case and the cache file. CI runs replay-only and
   reads from `.cache/`.

## Update the baseline

After an intentional prompt / model / pipeline change that legitimately
moves the aggregate score:

```bash
EVAL_RECORD=1 node backend/scripts/run-eval.mjs --write-baseline
```

Open a dedicated `chore(eval): rebaseline AUTO-022` PR with the new
`eval-baseline.json` so the rebaseline has its own review trail
separate from the change that caused it. Never bundle a rebaseline into
a `feat(prompt):` PR — they're separate concerns.

## Persisting scores for the Dashboard

The harness can write per-case scores into the existing `metric_samples`
time-series table (introduced by INF-007 / MET-001) so the Dashboard
`EvalPanel` renders trend charts without re-running the harness on every
page load:

```bash
node backend/scripts/run-eval.mjs --persist
```

Storage layout:

| Column | Value |
|---|---|
| `projectId` | `__eval_harness__` (sentinel — eval is workspace-agnostic) |
| `metricKey` | `eval.aggregate` / `eval.selectors` / `eval.actions` / `eval.assertions` |
| `value` | score in `[0, 1]` |
| `tags` | `{ runId, caseId, category }` (JSON) |

One row is written per dimension per case → 4 rows per case, so a 50-case
golden set produces 200 rows per harness invocation. Every row of one run
shares the same `runId` (uuid) so the Dashboard can group them when
rendering the drill-down view.

`--persist` is an opt-in flag — the default replay-mode CI path stays
read-only and never touches the database. Persist locally (or from a
nightly job against `develop`) so the trend chart has data without
bloating PR-time CI runs.

### Dashboard surface

When `metric_samples` has rows under the `__eval_harness__` sentinel, the
Dashboard renders the **AI Eval Quality** panel with four trend charts
(aggregate / selectors / actions / assertions) over the last 30 days plus
a "drill down" button on the most recent run. The drill-down opens a
side panel listing every case's per-dimension scores so you can see
which cases drove the latest run's score.

Backend surfaces:

| Route | Auth | Returns |
|---|---|---|
| `GET /api/v1/dashboard` | `anyAuthenticatedMember` | `evalTrend` block (null when no rows) |
| `GET /api/v1/dashboard/eval/:runId` | `anyAuthenticatedMember` | Per-case scores + `actual` + `expected` (404 if runId unknown) |

`actual` Playwright code is persisted on the `metric_samples` aggregate
row at run time (capped at 4 KB). `expected` is read from the on-disk
golden JSON at request time so the file on disk stays the canonical
source of truth — no risk of the DB and the fixture drifting apart.

## CI workflow

`.github/workflows/eval.yml` triggers on PRs that touch:

- `backend/src/pipeline/**`
- `backend/src/aiProvider.js`
- `backend/src/pipeline/prompts/**`
- `backend/src/eval/**`
- `backend/scripts/run-eval.mjs`
- `backend/tests/fixtures/eval-goldens/**`
- `eval-baseline.json`

The job runs `node backend/scripts/run-eval.mjs` in replay mode and
uploads `eval-report.json` as an artifact for reviewers.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `⚠️ AUTO-022 cold start — no cache entries recorded yet…` | First-run state: harness ships before any cache entries are recorded against the live LLM. CI exits 0 to unblock the merge. | Run `EVAL_RECORD=1 node backend/scripts/run-eval.mjs --write-baseline` on a maintainer machine with an LLM API key, commit the resulting `.cache/*.txt` + new `eval-baseline.json`. The cold-start guard turns off automatically when the baseline gains `perCase` / `byDimension` keys. |
| `eval cache miss for case-NNN (key …)` | New golden added or `PROMPT_VERSION` / `EVAL_MODEL` changed without re-recording (cold-start guard already disabled because real recordings exist) | Run `EVAL_RECORD=1 node backend/scripts/run-eval.mjs` and commit `.cache/<id>.<hash>.txt` |
| Aggregate score is suspiciously 1.0 on every case | Adapter is the identity stub, not the real pipeline | Confirm `pipelineAdapter.js#createDefaultPipeline` is wired and `EVAL_RECORD=1` was set when recording |
| Regression message blames every case | Broad regression — likely a prompt-template change or model swap, not a localised bug | Compare prompt diff; consider rebaseline if intentional |
| Replay works locally but CI fails | Stale cache committed; CI fetches fresh `node_modules` and may resolve a different model client | Re-record from a clean checkout |

## See also

- `backend/src/eval/pipelineEval.js` — scorer source
- `backend/src/eval/pipelineAdapter.js` — record / replay adapters
- `backend/scripts/run-eval.mjs` — CLI entrypoint
- `ROADMAP.md` § AUTO-022 — original spec and acceptance criteria
- `NEXT.md` § AUTO-022 — current sprint context