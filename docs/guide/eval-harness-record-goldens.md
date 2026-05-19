# Maintainer Brief: Recording Real DOM Goldens for AUTO-022

> **Audience:** A maintainer (or an agent with local-stack access + LLM API key) who can clone the repo, run the app, and exercise the production pipeline. This brief turns the 50 skeleton cases on the `ai-eval` branch into real, regression-detecting goldens.

> **Estimated effort:** 4–8 hours of focused work for a maintainer who knows the app. Half is DOM-capture mechanics; the other half is iterating on `expected` until scores are meaningful.

> **Output of this work:**
> 1. 50 case JSON files with real DOM snapshots replacing the synthetic placeholders.
> 2. 50 cache entries in `backend/tests/fixtures/eval-goldens/.cache/` (committed to repo).
> 3. A real `eval-baseline.json` with `aggregate`, `byDimension`, `byCategory`, and `perCase`.
> 4. CI green with the cold-start guard automatically deactivated.

---

## Why this is the most important remaining AUTO-022 work

The current 50 cases all have hand-written HTML like `<form><label>Name<input/></label>...</form>`. The production pipeline (`generateAllTests`) is tuned for real-app DOM with hundreds of elements, classes, ARIA attributes, state machines, etc. Synthetic 3-element fragments produce either:

- **Trivial generated code** that scores well by accident — false positive ("harness passing!")
- **Empty / nonsensical generated code** that scores zero — false negative ("harness failing!")

Neither measures real pipeline quality. Real DOM snapshots are non-negotiable for a credible regression gate.

---

## Rate-limited workflow (Gemini free tier, etc.)

If your only LLM access is a tight daily quota (e.g. **Gemini free tier =
20 requests/day**), you can't record all 50 cases in one sitting — and
even partial sessions waste calls if the harness re-records cases you
already captured yesterday. The CLI ships three flags specifically for
this scenario:

| Flag                | Purpose                                                                 |
|---------------------|-------------------------------------------------------------------------|
| `--cases=<csv>`     | Only run cases matching the comma-separated globs (e.g. `case-001,case-002` or `case-00*`). Anchored — `case-1` does NOT match `case-100`. |
| `--skip-cached`     | Skip any case that already has a `.cache/<id>.<hash>.txt` file on disk. |
| `--limit=N`         | Hard cap on cases processed (after `--cases` + `--skip-cached`). Stays inside your daily quota. |

### Recommended Gemini-free-tier schedule (3 sessions, ~18 cases each)

```bash
# Session 1 — records the first 18 cases that don't yet have a recording
EVAL_RECORD=1 EVAL_MODEL=gemini-2.5-flash \
  node backend/scripts/run-eval.mjs --skip-cached --limit=18

# Commit the 18 new cache files so they're not re-recorded tomorrow:
git add -f backend/tests/fixtures/eval-goldens/.cache/*.txt
git commit -m "chore(eval): record session 1 — 18 of 50 cases"

# Session 2 (next day) — records the next ~18 missing cases
EVAL_RECORD=1 EVAL_MODEL=gemini-2.5-flash \
  node backend/scripts/run-eval.mjs --skip-cached --limit=18

git add -f backend/tests/fixtures/eval-goldens/.cache/*.txt
git commit -m "chore(eval): record session 2 — 36 of 50 cases"

# Session 3 (third day) — records the remaining ~14 cases
EVAL_RECORD=1 EVAL_MODEL=gemini-2.5-flash \
  node backend/scripts/run-eval.mjs --skip-cached --limit=18

git add -f backend/tests/fixtures/eval-goldens/.cache/*.txt
git commit -m "chore(eval): record session 3 — all 50 cases captured"

# Final step — rebaseline against the FULL cache (no filters)
node backend/scripts/run-eval.mjs --write-baseline
git add eval-baseline.json
git commit -m "chore(eval): rebaseline against full cache"
```

Why `--limit=18` and not `--limit=20`: Gemini counts a tiny number of
preflight / metadata calls against your quota in some configurations.
The 2-call headroom protects against burning your daily allowance on
the 19th and 20th case only to have the harness's last call return
`429 Too Many Requests` and crash mid-record (leaving an incomplete
cache write on disk for that case).

### Single-case debugging

When iterating on `expected` for one specific case (Phase 2 below), you
also want to skip the other 49:

```bash
# Re-record only case-006 (e.g. after editing its snapshot / expected)
EVAL_RECORD=1 node backend/scripts/run-eval.mjs --cases=case-006
```

### Verify which cases still need recording

```bash
# Lists missing cases without making any LLM calls (--skip-cached is checked first)
node backend/scripts/run-eval.mjs --skip-cached --limit=0
```

Wait — `--limit=0` is rejected as invalid (positive integers only). To
preview which cases would be recorded next, run with a generous limit
in replay mode (no `EVAL_RECORD=1`) — `createReplayAdapter` will throw
"eval cache miss" for the un-recorded ones, listing them by id. The
harness exits with the first cache miss; that's the next case to
record. Alternatively, count cache files directly:

```bash
# How many cases are already recorded?
ls backend/tests/fixtures/eval-goldens/.cache/*.txt 2>/dev/null | wc -l

# Which case-NNN.json files don't yet have any cache entry?
for json in backend/tests/fixtures/eval-goldens/case-*.json; do
  id=$(basename "$json" .json)
  if ! ls backend/tests/fixtures/eval-goldens/.cache/$id.*.txt &>/dev/null; then
    echo "$id"
  fi
done
```

### Important guard rails

- **`--write-baseline` refuses to combine with incremental flags.** Partial
  recordings cannot rebaseline — the harness exits with code 2 if you
  pass `--write-baseline --cases=X` or any other filter. Rebaseline only
  after every case has a cache entry.
- **Incremental runs don't gate against the baseline.** A 5-case subset
  aggregate is not comparable to a 50-case baseline. Incremental runs
  always exit 0 (after printing per-case scores) so a partial subset
  divergence doesn't falsely fail CI.

---

## Phase 0 — Environment setup

### What you need

- Local clone of `rameshbabu-qa/sentri`, branch `ai-eval`
- Node.js 20+
- An LLM API key for whichever provider Sentri's `aiProvider.js` resolves to. Most likely:
  - `ANTHROPIC_API_KEY` (Claude)
  - or `OPENAI_API_KEY`
  - or `GOOGLE_API_KEY`
  - or a local Ollama instance running on `http://localhost:11434`
- Frontend + backend running so you can capture real DOM via Playwright

### Setup steps

```bash
# 1. Clone + check out the branch
git clone https://github.com/rameshbabu-qa/sentri.git
cd sentri
git checkout ai-eval

# 2. Install backend deps
cd backend && npm install && cd ..

# 3. Install frontend deps
cd frontend && npm install && cd ..

# 4. Set up env
cp backend/.env.example backend/.env
# Edit backend/.env: set JWT_SECRET (any 32+ char string) + your LLM key

# 5. Start backend (in one terminal)
cd backend && npm start

# 6. Start frontend (in another terminal)
cd frontend && npm run dev
```

### Verify the harness can talk to the LLM

Before touching any goldens, prove the live adapter works end-to-end:

```bash
EVAL_RECORD=1 node backend/scripts/run-eval.mjs
```

**Expected outcome on first run:**

- The harness picks up all 50 case JSONs.
- For each one, it invokes `generateAllTests` → `runPostGenerationPipeline` against the LLM.
- Writes `backend/tests/fixtures/eval-goldens/.cache/case-NNN.<hash>.txt` for each.
- Prints an aggregate score (will be low — most synthetic snapshots produce noise).

**If it crashes:**

- `rate limit` / 429 — wait, retry. Anthropic / OpenAI / Google all have per-minute caps.
- `no AI provider configured` — env vars not being read; check `backend/.env`.
- Playwright errors — `cd backend && npx playwright install chromium`.

**Sanity-check before proceeding:** open one cache file (e.g. `.cache/case-001.<hash>.txt`). It should contain Playwright code (`await page.click(...)` / `await expect(...)`). If it's empty or "(no tests generated)", the pipeline isn't working with synthetic snapshots — see Phase 1 below.

---

## Phase 1 — Replace synthetic snapshots with real DOM captures

### Strategy: source from existing E2E specs

Sentri already has E2E specs under `tests/e2e/specs/` that exercise real flows. Each existing spec is a candidate seed for one or more golden cases.

The mapping from category → likely E2E specs:

| Category | Cases | Suggested seed E2E specs |
|---|---|---|
| `form-fill` (10 cases: 001, 006–014) | 10 | `tests/e2e/specs/project-create-ui.spec.mjs`, `quality-gates-ui.spec.mjs`, `environments-ui.spec.mjs`, `test-fixtures-ui.spec.mjs` |
| `list-click` (10 cases: 002, 015–023) | 10 | `tests/e2e/specs/recorder-gaps-ui.spec.mjs` (table rows), any list-rendering spec |
| `modal` (10 cases: 003, 024–032) | 10 | Any spec that opens a confirm dialog or settings modal |
| `multi-page-nav` (10 cases: 004, 033–041) | 10 | `tests/e2e/specs/ui-smoke.spec.mjs` (login → dashboard), `run-detail-root-cause-ui.spec.mjs` |
| `assertion-heavy` (10 cases: 005, 042–050) | 10 | Any spec with multiple `expect(page.…)` post-conditions |

### Step-by-step capture procedure

For each `case-NNN.json` file:

**Step 1.1 — Read the case to understand intent**

```bash
cat backend/tests/fixtures/eval-goldens/case-006.json
```

Note the `description` field — it tells you what flow the case represents. For `case-006` it's "multi-field signup form."

**Step 1.2 — Find the matching real flow in the running app**

For `case-006`: open `http://localhost:5173/register`. Don't fill the form yet — capture the DOM in its initial empty state so the harness can score whether the generated test fills it correctly.

**Step 1.3 — Capture the DOM via Playwright**

Create `scripts/capture-golden.mjs` (don't commit this — it's a maintainer-local tool):

```javascript
import { chromium } from "@playwright/test";
import fs from "node:fs";

const [, , url, outFile] = process.argv;
if (!url || !outFile) {
  console.error("Usage: node scripts/capture-golden.mjs <url> <outfile>");
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle" });

// Optional: wait for specific element. Tweak per case.
// await page.waitForSelector("form");

const html = await page.content();
fs.writeFileSync(outFile, html);
console.log(`captured ${html.length} bytes → ${outFile}`);

await browser.close();
```

Run it:

```bash
node scripts/capture-golden.mjs http://localhost:5173/register /tmp/case-006-snapshot.html
```

**Step 1.4 — Decide between inline vs `@file:` reference**

- Snapshot ≤ 5 KB after minification → inline in JSON
- Snapshot > 5 KB → store as `snapshots/case-NNN.html` and reference via `"snapshot": "@file:snapshots/case-NNN.html"`

Most real captures will be > 5 KB. Use `@file:` references liberally.

```bash
mkdir -p backend/tests/fixtures/eval-goldens/snapshots
mv /tmp/case-006-snapshot.html backend/tests/fixtures/eval-goldens/snapshots/case-006.html
```

**Step 1.5 — Update the case JSON**

```json
{
  "id": "case-006",
  "category": "form-fill",
  "description": "Sentri register page — multi-field signup form (name + email + password) with confirm-email follow-up.",
  "url": "http://localhost:5173/register",
  "snapshot": "@file:snapshots/case-006.html",
  "expected": "await page.getByLabel('Name').fill('Eval User');\nawait page.getByLabel('Email').fill('eval@example.com');\nawait page.getByLabel('Password').fill('hunter2!');\nawait page.getByRole('button', { name: 'Create account' }).click();\nawait expect(page.getByText('Check your email')).toBeVisible();"
}
```

**Important:** update `description` from "Skeleton golden — Replace ..." to a real human-readable description. **This is how reviewers tell at a glance which cases are real vs still skeleton.**

**Step 1.6 — Auth-protected pages**

Most of Sentri's interesting flows (`/dashboard`, `/projects/:id`, `/settings`) require login. Extend the capture script to log in first:

```javascript
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.request.post("http://localhost:3001/api/v1/auth/register", {
  data: { name: "Eval", email: "eval@local.test", password: "hunter2!" },
});
await page.request.post("http://localhost:3001/api/v1/auth/login", {
  data: { email: "eval@local.test", password: "hunter2!" },
});

await page.goto("http://localhost:5173/projects");
const html = await page.content();
```

Or reuse `tests/e2e/utils/auth.mjs` + `tests/e2e/utils/session.mjs` — they already encapsulate the login dance.

---

## Phase 2 — Iterate `expected` until scores are meaningful

The harness scores `actual` (what the LLM generates from the snapshot) against `expected` (what you wrote in the JSON). If `expected` is wishful — what you'd *like* the pipeline to emit rather than what it realistically does — every case scores low and the baseline is meaningless. The goal is for `expected` to closely mirror the pipeline's typical output style, so the score is sensitive to **regressions** rather than to the eternal gap between aspiration and reality.

### Per-case iteration loop

```bash
# 1. Re-record cache for this one case
EVAL_RECORD=1 node backend/scripts/run-eval.mjs --report=/tmp/eval-report.json

# 2. Inspect the actual code the pipeline emitted
cat backend/tests/fixtures/eval-goldens/.cache/case-006.*.txt

# 3. Compare to your expected
cat backend/tests/fixtures/eval-goldens/case-006.json | jq -r '.expected'

# 4. Check the per-case score in the report
cat /tmp/eval-report.json | jq '.cases[] | select(.caseId == "case-006") | .score'
```

### Target scores per case

| Score range | Meaning | Action |
|---|---|---|
| `aggregate >= 0.7` | `expected` is realistic — pipeline output mostly matches | Commit and move on |
| `aggregate 0.4–0.7` | Style mismatch (e.g. `getByLabel` vs `getByPlaceholder`) | Adjust `expected` to match the pipeline's actual phrasing |
| `aggregate < 0.4` | Either snapshot is wrong (pipeline can't extract anything meaningful) OR `expected` is fundamentally different from what the pipeline does | Investigate before adjusting — a too-eager `expected` rewrite masks real pipeline issues |
| `aggregate == 1.0` | Either bug, or you copy-pasted the cache file content into `expected` | Re-check; this should never happen on a real case |

### Common adjustment patterns

1. **Selector style mismatch.** Pipeline emits `page.getByRole('button', { name: 'Submit' })`; you wrote `page.getByText('Submit')`. The pipeline's choice is canonical — update `expected`.
2. **Assertion specificity.** Pipeline emits `await expect(page.getByText('Saved')).toBeVisible()`; you wrote `await expect(page.getByRole('status')).toContainText('Saved')`. Both are valid — pick the pipeline's version.
3. **Order differences.** Pipeline emits actions in a different order than you wrote. **Don't** reorder `expected` to match — the scorer treats action/assertion order as semantic (clicking Submit before filling the form is a real bug). If the pipeline's order is genuinely wrong, that's a regression signal you want to preserve.
4. **Extra cleanup steps.** Pipeline emits a leading `await page.goto(...)` that your `expected` doesn't have. Add it if the pipeline reliably emits it.

### Iterate in batches, not one-by-one

After Phase 1 captures, run all 50 cases once:

```bash
EVAL_RECORD=1 node backend/scripts/run-eval.mjs --report=/tmp/eval-report.json
```

Then sort by per-case score:

```bash
cat /tmp/eval-report.json | jq -r '.cases | sort_by(.score.aggregate) | .[] | "\(.score.aggregate | . * 100 | floor)% \(.caseId) - \(.category)"'
```

Work the lowest-scoring 10 cases first — they're either snapshot bugs or `expected` mismatches that are easy to fix in a focused session.

---

## Phase 3 — Lock in the baseline

Once every case scores ≥ 0.7 (or you've consciously decided some cases are intentionally harder and accept a 0.5 floor):

```bash
EVAL_RECORD=1 node backend/scripts/run-eval.mjs --write-baseline
```

This regenerates `eval-baseline.json` with:

```json
{
  "aggregate": 0.83,
  "byDimension": {
    "selectors": 0.85,
    "actions": 0.82,
    "assertions": 0.81
  },
  "byCategory": {
    "form-fill": 0.86,
    "list-click": 0.79,
    "modal": 0.84,
    "multi-page-nav": 0.81,
    "assertion-heavy": 0.83
  },
  "perCase": {
    "case-001": 0.91,
    "case-002": 0.78
  },
  "recordedAt": "2026-MM-DDTHH:mm:ss.sssZ"
}
```

The presence of `byDimension` and `perCase` keys is what flips `isBootstrapState()` in `run-eval.mjs` from `true` → `false`. After this commit, CI uses the strict regression gate.

---

## Phase 4 — Commit the artifacts

Three categories of files need to land in the same PR:

**4.1 — Updated case JSONs**

```bash
git add backend/tests/fixtures/eval-goldens/case-*.json
```

**4.2 — Large snapshot files (if you used `@file:` references)**

```bash
git add backend/tests/fixtures/eval-goldens/snapshots/
```

**4.3 — Cache entries**

`.cache/` is currently gitignored. Force-add the files:

```bash
git add -f backend/tests/fixtures/eval-goldens/.cache/*.txt
```

**Important sub-step:** Update `.gitignore` so future agents don't accidentally re-ignore these. Replace the existing block with:

```diff
-backend/tests/fixtures/eval-goldens/.cache/
+# Lock-file pattern: ignore everything in .cache/ EXCEPT committed
+# recordings (which CI replays against). New recordings must be added
+# with `git add -f .cache/<id>.<hash>.txt` after EVAL_RECORD=1 run.
+backend/tests/fixtures/eval-goldens/.cache/*
+!backend/tests/fixtures/eval-goldens/.cache/*.txt
+!backend/tests/fixtures/eval-goldens/.cache/.gitkeep
```

This pattern ignores transient files in `.cache/` (partial writes, swap files) but allows committed `.txt` recordings.

**4.4 — Updated baseline**

```bash
git add eval-baseline.json
```

**4.5 — Commit + push**

```bash
git commit -m "chore(eval): record AUTO-022 golden snapshots + baseline against live LLM

Replaces the 50 synthetic skeleton cases with real DOM captures from the
Sentri application. Records the corresponding LLM response cache so CI
runs against committed responses (no network calls in replay mode).

Cache entries are committed via .gitignore exception. Future re-records
follow the same procedure documented in docs/guide/eval-harness-record-goldens.md.

Aggregate baseline: <X>% across <N> cases (was placeholder 100% pre-record).
"
git push
```

---

## Phase 5 — Verify CI passes the strict gate

After pushing, the `Eval — Golden-set regression check` job will:

1. Skip the cold-start bypass (baseline now has `perCase` / `byDimension` keys).
2. Run `createReplayAdapter` against the committed cache.
3. Score against the new `eval-baseline.json`.
4. Exit 0 — aggregate equals baseline (zero regression on the recording run).

**Sanity check the first PR-with-real-data:** the report artifact uploaded by `eval.yml` should show an aggregate close to (within 1–2% of) the value you committed in `eval-baseline.json`. If it's significantly different, that's a hint the pipeline is non-deterministic between local + CI environments (different Node version, different Playwright, etc.).

---

## Phase 6 — Document the recording artifacts

Add a short note to `docs/guide/eval-harness.md` § "Update the baseline" so the next person who needs to re-record has a clear template:

```markdown
### What constitutes a real golden vs a skeleton

A "real" golden has:
1. A `snapshot` field captured from the running app via `page.content()` (typically 5–50 KB, often referenced via `@file:snapshots/<id>.html`).
2. A `description` that names the actual flow (NOT starting with "Skeleton golden — Replace ...").
3. A matching cache entry in `.cache/<id>.<hash>.txt`.
4. A per-case score in `eval-baseline.json#perCase` ≥ 0.4.

If any of these are missing, the case is still a skeleton and should be replaced before the case counts toward the regression gate.
```

---

## Tips for the agent doing this work

1. **Don't try to capture all 50 in one sitting.** Do a vertical slice first: 1 case from each of the 5 categories, full Phase 1 → Phase 3 loop on those 5. Confirm the harness behaves sensibly, then batch-process the remaining 45.

2. **Save your capture script.** Even though you shouldn't commit it, save it locally — re-recording in 6 months when prompt templates change will need it again.

3. **Watch for non-determinism between captures.** If `page.content()` returns slightly different HTML on consecutive calls (timestamps, random IDs, animation states), the cache hash will change and the harness will report "cache miss" until you re-record. Two mitigations:
   - Capture after `page.waitForLoadState("networkidle")` + a small `await page.waitForTimeout(500)` for animations.
   - Strip volatile attributes from the captured HTML before saving (e.g. `data-react-*-id`, randomly-generated test IDs).

4. **`expected` should match the pipeline's style, not your style.** The first instinct is to write your dream Playwright code in `expected`. Resist. The harness measures regression, not idealism — `expected` should reflect what the pipeline reliably produces *today* so a future change can be detected.

5. **Watch the LLM cost.** Recording 50 cases against Claude / GPT-4 will cost a few dollars per full record pass. Iterate cheaply by:
   - Using Ollama locally (free) for the first pass to debug the `expected` field structure.
   - Only switching to a paid provider for the final lock-in record.

6. **The cache key includes `EVAL_MODEL`.** If you record with Claude 3.5 and another maintainer later runs with Claude 4, every cache entry will miss. Either:
   - Pin `EVAL_MODEL` explicitly in CI (`EVAL_MODEL=claude-3-5-sonnet-20241022 node ...`).
   - Accept that model upgrades require a full re-record (document this in `eval-harness.md`).

7. **If a case truly can't reach 0.4 even after tuning,** delete the case rather than ship a noisy baseline. 40 good cases is more useful than 50 mediocre ones.

---

## What "done" looks like

- [ ] 50 cases in `backend/tests/fixtures/eval-goldens/` with real DOM snapshots (descriptions updated from "Skeleton golden — ..." to real flow names)
- [ ] `backend/tests/fixtures/eval-goldens/snapshots/` directory exists with `case-*.html` files for large captures
- [ ] `backend/tests/fixtures/eval-goldens/.cache/` directory exists with `case-*.txt` files committed (≥50 files, force-added)
- [ ] `.gitignore` updated to allow `*.txt` in `.cache/` while still ignoring transient files
- [ ] `eval-baseline.json` rewritten with `perCase` + `byDimension` + `byCategory` keys + a realistic `aggregate` (~0.7–0.9)
- [ ] CI `Eval — Golden-set regression check` passes against the real baseline (not the cold-start bypass)
- [ ] `docs/guide/eval-harness.md` § "What constitutes a real golden" section added
- [ ] PR opened as `chore(eval): record AUTO-022 golden snapshots + baseline against live LLM`

Once this PR merges, the harness gate is live. The next prompt / model change that regresses generation quality on any of the 50 captured flows will fail CI with a named list of affected cases — which is what AUTO-022 was always supposed to deliver.

---

## See also

- `docs/guide/eval-harness.md` — operator guide (inspect-regression / update-baseline / add-golden workflows)
- `backend/src/eval/pipelineEval.js` — scorer source
- `backend/src/eval/pipelineAdapter.js` — record / replay adapter (`createReplayAdapter`, `createLiveAdapter`)
- `backend/scripts/run-eval.mjs` — CLI entrypoint (`--write-baseline`, `--report=`, `--persist`, `--cases=<glob>`, `--skip-cached`, `--limit=N`, `EVAL_RECORD=1`)
- `ROADMAP.md` § AUTO-022 — original spec and acceptance criteria
- `NEXT.md` § AUTO-022 — current sprint context
