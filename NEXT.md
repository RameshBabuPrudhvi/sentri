# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## 🚨 10-Day Production Readiness Plan

> **Production target:** ship in 10 days. Only **one** roadmap item is a hard prod blocker (`INF-006`); every 🟡 High item in Phase 2 is already ✅. The plan below is sequenced so the first 5 days clear the blocker and Golden E2E, leaving slack for review-thread cleanup and a stabilisation window before tag.

| Day | Focus | Owner |
|---|---|---|
| 1–2 | **INF-006** — Render Blueprint + ephemeral-storage warning + README callout (Effort: S) | Backend |
| 2–3 | Resolve **all open PR review threads** (start with `permissions.json` line numbers off by 5) | All |
| 3–5 | Run **Golden E2E Happy Path** (`QA.md:240-340`, 51 steps) on Chrome + at least one other browser | QA |
| 5–6 | **Fix any Blocker / Critical bugs** found during the QA pass | All |
| 6–7 | (optional) **DIF-015b Gap 2** — recorder data-testid scoring (Effort: S, contained) | Backend |
| 7–8 | (optional) **AUTO-012** — SLA / quality gate enforcement (Effort: M, only if customer-driven) | Backend |
| 8–10 | Stabilisation window: CI green ≥ 2 days on `main`; cut release tag | All |

**Explicitly deferred (do not ship in this window):** SEC-004 (MFA), SEC-005 (SSO), DIF-005 / DIF-008 / DIF-009 / DIF-010 / DIF-012, all Phase 4 items except the optional AUTO-012. Track post-launch on customer demand.

---

## ▶ Current PR — INF-006

**Title:** Persistent storage on hosted deployments (Render disk + Postgres add-on)
**Branch:** `fix/INF-006-render-persistent-storage`
**Effort:** S | **Priority:** 🔴 Blocker (only remaining prod blocker)
**All dependencies:** None — INF-001 ✅ already shipped Postgres adapter support

### Why this blocks production

Render / Fly / Railway free-tier filesystems are ephemeral. Every redeploy wipes `backend/data/sentri.db` — operators dogfooding on Render must re-register, recreate every project, and re-run every crawl after every deploy. There is no `render.yaml`, no documented disk path, and no production-hardening callout that SQLite + free-tier hosting is incompatible. Without this, the first production deploy loses data on the second push. (Source: PR #115 dogfooding feedback.)

### What to build

- `render.yaml` Blueprint at the repo root: web service + 1 GB Persistent Disk mounted at `/app/backend/data` + commented-out free Postgres add-on.
- `backend/.env.example` — new `# Hosted deployment` section documenting both paths (disk-mounted SQLite vs Render Postgres) and the trade-off.
- `backend/src/index.js` — startup probe that detects ephemeral storage (DB path inside `/tmp` or no recent writes from a prior process) and emits a single `formatLogLine("warn", …)` "DB path appears ephemeral — data will be lost on redeploy".
- `README.md` + `docs/getting-started.md` — "Production deployments" callout naming Render / Fly / Railway free-tier ephemeral disks as the footgun, with copy-pasteable fixes.

### Files to change

| File | Change |
|------|--------|
| `render.yaml` (new) | Render Blueprint with disk + optional Postgres add-on |
| `backend/.env.example` | Hosted deployment section (`DB_PATH`, `DATABASE_URL`) |
| `backend/src/index.js` | Ephemeral-storage warning at boot |
| `README.md` · `docs/getting-started.md` | Production deployment callout |
| `docs/changelog.md` | `### Added` entry once shipped |

### Acceptance criteria

- A fresh Render deployment from `render.yaml` survives redeploys without wiping accounts, projects, tests, or runs.
- Operators get a single visible log line at boot when the DB path is ephemeral.
- README explicitly names Render free-tier ephemeral disk as a footgun and points to the Blueprint.

### PR checklist

- [ ] Update `INF-006` status in `ROADMAP.md` to ✅ Complete with PR number
- [ ] Update this file: move INF-006 to "Recently completed", promote AUTO-012 to Current PR
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`
- [ ] Update `QA.md` cross-cutting checks with a "Hosted deployment" verification step

---

## ⏭ Queue (next 3 PRs after current)

### 2 · AUTO-012 — SLA / quality gate enforcement
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** none

Per-project `qualityGates` config (min pass rate, max flaky %, max failures). On run completion, evaluate gates and include `{ passed, violations[] }` in both the trigger response and run result. GitHub Action exit code reflects gate status. **Was the previous Current PR;** demoted because INF-006 is the only true prod blocker. Ship in the 10-day window only if customer-driven; otherwise defer to first post-launch sprint.

**Files:** `backend/src/routes/projects.js` · `backend/src/testRunner.js` · `backend/src/routes/trigger.js` · `frontend/src/pages/ProjectDetail.jsx`

### 3 · DIF-015b Gap 2 — Recorder selectorGenerator: data-testid quality scoring
**Effort:** S | **Priority:** 🔵 Medium | **Dependencies:** none

Score data-testid candidates in the recorder's `selectorGenerator()` priority chain so generic / auto-generated ids (e.g. `data-testid="btn-1"`, hash-suffixed values) are demoted in favour of stable semantic ids. Highest-value next step toward flipping DIF-015b to ✅ Complete in `ROADMAP.md` once Gap 3 also ships. Heuristics + acceptance criteria documented in `ROADMAP.md § DIF-015b`. Small, contained — fits a stabilisation-window slot if AUTO-012 doesn't get picked.

**Files:** `backend/src/runner/recorder.js` (only)

### 4 · AUTO-017 — Performance budget testing (Web Vitals)
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none

Capture Web Vitals (LCP, CLS, INP, TTFB) per page during runs and compare against per-project budgets. Surface budget violations as a new run-result section and gate runs when budgets are exceeded. First post-launch differentiator candidate.

**Files:** `backend/src/runner/pageCapture.js` · `backend/src/testRunner.js` · `frontend/src/components/run/StepResultsView.jsx`

---

## 🔀 Parallel opportunities (small items, no queue conflicts)

These can be picked up by a second engineer alongside the current PR without file conflicts:

| ID | Title | Effort | Shared files? |
|----|-------|--------|---------------|
| **DIF-015b Gap 2** | **Recorder selectorGenerator: data-testid quality scoring** | **S** | **`backend/src/runner/recorder.js` only — no overlap with INF-006 (current PR) / AUTO-012 / AUTO-017** |
| DIF-015b Gap 3 | Recorder selectorGenerator: iframe + shadow-DOM traversal | M | `backend/src/runner/recorder.js` only |
| AUTO-017 | Performance budget testing (Web Vitals) | M | None |
| AUTO-019 | Run diffing: per-test comparison across runs | M | None |

> **DIF-015b follow-up priority:** Gap 2 (data-testid scoring) is the highest-value next step — it's a small, contained edit to the priority chain in `selectorGenerator()` and unblocks DIF-015b flipping to ✅ Complete in ROADMAP.md once Gap 3 also ships. Both gaps are documented in `ROADMAP.md` § DIF-015b with concrete heuristics, files-to-change, and acceptance criteria. Pick Gap 2 next; defer Gap 3 to a separate PR (different effort tier).
>
> Why these aren't promoted to "Current PR": INF-006 (Render Blueprint) is the only remaining 🔴 Blocker before production. The recorder gaps are tracked here so they don't get lost — pick them up alongside INF-006 if a second agent has bandwidth (zero file overlap; INF-006 only touches `render.yaml` / `index.js` / docs).

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| ENH-036 + ENH-036b | Project credential editing (`PATCH /projects/:id`) + auto-detect login form fields (semantic-first locator waterfall) | #1 |
| AUTO-016b | Frontend CrawlView a11y panel + dashboard offenders rollup | #1 |
| DIF-007 | Conversational test editor connected to /chat (in-app "Edit with AI" panel with diff preview + apply) | #123 |

*Full completed list → ROADMAP.md § Completed Work*