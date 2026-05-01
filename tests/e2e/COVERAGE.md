# E2E Automation Coverage

> **Single source of truth for what's automated vs. still manual.** Mirrors `QA.md`'s Golden E2E Happy Path (51 steps, `QA.md:240-340`) and per-feature happy paths. When a step is automated, link the spec; when not, mark `🟥` so the next agent knows where to add coverage.
>
> **For agents:** read the **Backlog** section below first. Pick the top item, write the spec under `tests/e2e/specs/`, flip the row to ✅ in the same PR. Use `tests/e2e/utils/auth.mjs` + `tests/e2e/utils/session.mjs` — never inline auth or CSRF logic in a spec.
>
> **For humans:** when shipping a user-facing feature, add at least one ✅ row here in the same PR (per `REVIEW.md` § Mandatory Test Requirements). The backfill queue itself is tracked as `MNT-012 — E2E coverage backfill` in `ROADMAP.md`.

## UI-only policy

**Every Sentri flow has a UI surface, so every row must be driven through the browser.** Specs run under `--project=ui-chromium` using the Playwright `page` fixture, real DOM, and role-based selectors. There is no "API-only ✅" — an API spec by itself never closes a row.

API specs are still permitted, but only as **scaffolding** for the UI spec (e.g. seeding a verified user via `request.post("/api/auth/register")` so the UI test can drive `/login` directly, or pre-creating fixtures like an approved test). They never count toward ✅ on their own; the assertion that flips a row to ✅ must be a `expect(page.…)` call against the rendered UI.

The only exception is the ⏭️ tier — flows with genuinely no user-facing UI (outbound notifications, disk-mount probes). Those are explicitly out of scope here and covered at the unit/integration layer.

## Status legend

- ✅ **Fully automated** — happy path driven through `page.*` in a `ui-chromium` spec; runs in CI on every PR
- 🟨 **Partial** — UI spec started but missing assertions; gaps called out in the row
- 🟥 **Not automated** — only manual coverage in `QA.md`. May have an existing API spec used as scaffolding — the row tracks UI coverage only.
- ⏭️ **Out of scope** — no user-facing UI surface (e.g. outbound notifications, ephemeral-storage probe)

---

## 🚀 Backlog — next 20 to automate

Pick the top item. Each is sized to fit one PR (1–3 specs, ≤ 200 LOC each), **UI by default**. If a UI spec isn't feasible, document the reason in the row and mark `(API-only)` per the UI-first policy above.

Items are grouped into three **tiers** by fixture cost. Stay within one tier per PR — mixing a Tier 1 spec with a Tier 3 spec ties a 5-minute scaffold to a 30-minute fixture, slowing review and inflating CI runtime. Aim for 5–8 specs per backfill PR; more than that becomes unreviewable.

### Tier 1 — register + login scaffolding only (easy, parallelisable)

1. **Workspace — invite collaborator UI flow** (`QA.md` §2 step 4) → new `tests/e2e/specs/workspace-invite-ui.spec.mjs`: drive Settings → Members invite form, assert pending invite appears, then accept-link flow in incognito confirms membership. **UI-only.**
2. **Project — edit existing (ENH-036)** (`QA.md` §📁 Projects row) → new `tests/e2e/specs/project-edit-ui.spec.mjs`: pencil-icon → `/projects/new?edit=<id>` form pre-filled, change name, save, assert updated name on `/projects/:id` and in the list. **UI-only.**
3. **Auth — forgot / reset password** (`QA.md` §🔐 Authentication) → new `tests/e2e/specs/forgot-password-ui.spec.mjs`: drive `/forgot-password` → seed reset token via repo → drive `/reset-password?token=…` → log in with new password. **UI-only.**
4. **Automation — trigger token create / list / revoke** (`QA.md` §⚡ Automation) → new `tests/e2e/specs/automation-tokens-ui.spec.mjs`: `/automation` page TokenManager → create token (assert plaintext shown once) → list shows hash → revoke clears the row. **UI-only.**
5. **AI Chat — session create / rename / delete** (`QA.md` §🤖 AI Chat) → new `tests/e2e/specs/ai-chat-sessions-ui.spec.mjs`: `/chat` page → New session → rename via inline edit → delete confirms removal. Skip multi-turn LLM responses (Tier 3). **UI-only.**
6. **Settings — AI provider key save + restore** (`QA.md` §⚙️ Settings) → new `tests/e2e/specs/settings-ai-key-ui.spec.mjs`: enter key → save → reload → assert key persists (masked). **UI-only.**
7. **Account / GDPR — export + delete** (`QA.md` §19 steps 48-49) → new `tests/e2e/specs/account-gdpr-ui.spec.mjs`: Settings → Account → password-confirmed export download triggers; delete shows the 5s-disarm confirm. **UI-only.**
8. **Email Verification — resend + grandfathering** (`QA.md` §📧 Email Verification) → new `tests/e2e/specs/email-verify-resend-ui.spec.mjs`: register without `SKIP_EMAIL_VERIFICATION` → Login page shows "verify your email" → click Resend → assert toast. **UI-only.** (Note: requires `SKIP_EMAIL_VERIFICATION` unset for this spec — guard with env-aware skip.)

### Tier 2 — seeded fixtures (medium; introduce shared `tests/e2e/utils/fixtures.mjs` first)

9. **Tests review — approve / reject + ReviewModal** (`QA.md` §7 step 13–15) → new `tests/e2e/specs/tests-review-ui.spec.mjs`: seed Draft tests via API, then drive the Tests page filter pills + bulk-approve toolbar via `getByRole('button', { name: /approve/i })`. **UI-only.**
10. **Tests — bulk approve / reject + keyboard shortcuts** (`QA.md` §🧪 Tests Page · §☑️ Bulk actions) → new `tests/e2e/specs/tests-bulk-ui.spec.mjs`: seed 5 Draft tests → checkbox-select → bulk action toolbar → assert status flips. Cover `/`, `a`, `r`, `Esc` keyboard shortcuts as a second test. **UI-only.**
11. **Permissions — viewer 403 / outsider 403** (`QA.md` §20 steps 50-51) → new `tests/e2e/specs/permissions-ui.spec.mjs`: seed second user as `viewer` → log in → assert role-gated buttons hidden / 403 toast on click. Outsider URL → redirect or 403 page. **UI-only.**
12. **Recycle Bin — restore + purge** (`QA.md` §18 steps 46-47) → new `tests/e2e/specs/recycle-bin-ui.spec.mjs`: seed soft-deleted project → Settings → Recycle Bin → restore returns it to `/projects`; purge removes permanently. **UI-only.**
13. **Audit Log — filter by user** (`QA.md` §🧾 Audit Log) → new `tests/e2e/specs/audit-log-ui.spec.mjs`: seed activity rows for two users → Settings → Audit Log → filter by user → assert only that user's rows render. **UI-only.**
14. **Export — Zephyr / TestRail / Playwright ZIP** (`QA.md` §15 steps 39-41) → new `tests/e2e/specs/export-formats-ui.spec.mjs`: seed approved tests → ProjectExportMenu dropdown → assert `download` event fires for each format using Playwright's `page.waitForEvent('download')`. **UI-only.**
15. **API imports — OpenAPI / HAR / `METHOD /path`** (`QA.md` §📤 API imports) → new `tests/e2e/specs/api-import-ui.spec.mjs`: ImportApiModal → paste each format → assert imported tests appear as Draft. **UI-only.**
16. **Runs list — filter by status / project** (`QA.md` §📋 Runs list) → new `tests/e2e/specs/runs-filter-ui.spec.mjs`: seed runs across statuses + projects → `/runs` filter pills → assert table only shows matching rows. **UI-only.**
17. **Workspaces — switch workspace** (`QA.md` §👥 Workspaces) → new `tests/e2e/specs/workspace-switch-ui.spec.mjs`: seed a second workspace + membership → topbar workspace switcher → assert project list updates. **UI-only.**
18. **Notifications — at-least-one-channel validation** (`QA.md` §🔔 Notifications) → new `tests/e2e/specs/notifications-config-ui.spec.mjs`: ProjectDetail → Settings → Notifications → save with all channels blank → assert inline validation error. **UI-only.** (Outbound side-effects remain ⏭️.)

### Tier 3 — real runs / browsers / LLM (hard; may need Playwright `route()` mocks)

19. **Run regression — RunRegressionModal + live RunDetail** (`QA.md` §9 step 20–22) → new `tests/e2e/specs/run-regression-ui.spec.mjs`: open the modal, set `parallelWorkers: 2`, click Run, assert RunDetail SSE log streams in and the per-test status badges update. **UI-only** (SSE is the user surface; consume it via `page` not `request`). Recommend Playwright `route()` to stub the target site.
20. ~~**Quality gates — RunDetail badge + violation panel**~~ ✅ shipped — `quality-gates-ui.spec.mjs` now covers RunDetail badge + violation panel via `page.route()` mock of `/api/v1/runs/:runId`. Replace with next Tier 3 candidate when picking up.

**Why this ordering:** Tier 1 (8 specs) is parallelisable across agents with zero shared fixtures. Tier 2 (10 specs) should land a shared `tests/e2e/utils/fixtures.mjs` helper alongside its first 1–2 specs so subsequent ones reuse the seeded-test/run/workspace primitives instead of duplicating them. Tier 3 (2 specs) needs route-mocking infrastructure and should land last; the 🟥 rows it leaves behind (Crawl link mode, Visual baseline, AI Fix SSE, Generate AI test draft, Recorder start/stop, Edit Steps↔Source) are deferred to a follow-on sprint once Tier 3 patterns are proven.

---

## 🌟 Golden E2E Happy Path coverage (`QA.md:240-340`)

| QA.md ref | Step / flow | Spec | Status |
|---|---|---|---|
| Sec 1, steps 1-3 | Auth - register & verify (email link) | UI: `ui-smoke.spec.mjs` :: *verified user can sign in and land on dashboard with workspace visible* · scaffolding: `api-auth.spec.mjs` :: *register creates user and login is blocked until verification* | 🟥 (Pending CI: `UI E2E — Playwright smoke (Chromium)` must pass before flipping ✅) |
| Sec 1, steps 1-3 | Auth — wrong-password rejection | UI: `ui-smoke.spec.mjs` :: *invalid credentials show an error state* · scaffolding: `api-auth.spec.mjs` :: *login negative path with bad password* | ✅ |
| Sec 2, step 4 | Workspace — invite collaborator | — | 🟥 (UI: Settings → Members invite form + accept-link incognito flow) |
| Sec 3, step 5 | Project — create | UI: `project-create-ui.spec.mjs` :: *verified user can create a project via the form and see it in the list* · scaffolding: `full-functional-api.spec.mjs` :: *verify account, login, project+test CRUD happy path* | ✅ |
| Sec 4, step 6 | Crawl — link mode | UI: — · scaffolding: `functional-areas.spec.mjs` :: *crawl + generate + recorder + ai-fix/chat endpoint contracts* | 🟥 (UI: ProjectDetail → CrawlProjectModal → live progress → completed badge) |
| Sec 4, step 7 | Crawl — state exploration | — | 🟥 (UI: CrawlProjectModal mode selector + state-explorer progress) |
| Sec 5, steps 8-9 | Generate — AI test draft creation | UI: — · scaffolding: `functional-areas.spec.mjs` :: *crawl + generate + recorder + ai-fix/chat endpoint contracts* | 🟥 (UI: Tests page → GenerateTestModal → Draft test row appears) |
| Sec 6, steps 10-12 | Recorder — start/stop session | UI: — · scaffolding: `functional-areas.spec.mjs` :: *crawl + generate + recorder + ai-fix/chat endpoint contracts* | 🟥 (UI: Tests page → RecorderModal → forward canvas events → Stop & Save → Draft test) |
| Sec 7, steps 13-15 | Review — approve / reject test | UI: — · scaffolding: `functional-areas.spec.mjs` :: *project tests workflow: create, approve/reject/restore, export, run* | 🟥 (UI: Tests page filter pills + bulk approve toolbar + ReviewModal) |
| Sec 8, steps 16-19 | Edit — Steps ↔ Source diff/preview | — | 🟥 (UI: TestDetail Steps↔Source toggle + diff modal + accept/discard) |
| Sec 9, steps 20-22 | Run — execute regression | — | 🟥 (UI: RunRegressionModal → live RunDetail SSE log + per-test status badges) |
| Sec 10, steps 23-26 | AI Fix — manual flow | UI: — · scaffolding: `functional-areas.spec.mjs` :: *crawl + generate + recorder + ai-fix/chat endpoint contracts* | 🟥 (UI: TestDetail "Fix with AI" → SSE stream renders → Accept → re-approve) |
| Sec 11, steps 27-29 | Visual baseline — first run + accept | — | 🟥 (UI: RunDetail Visual tab → diff PNG visible → "Accept visual changes" button) |
| Sec 12, steps 30-34 | Run results / artifacts / reports | — | 🟥 (UI: RunDetail artifact downloads + `/reports` page renders + Dashboard PDF export) |
| Sec 13, step 35 | Notifications — Teams/email/webhook fire | — | ⏭️ (Outbound side-effects — no user-facing UI; covered by `notifications-api.test.js` unit tests) |
| Sec 14, steps 36-38 | Automation — CI/CD trigger token + cron schedule | UI: — · scaffolding: `full-functional-api.spec.mjs` :: *session security: logout revokes access and missing CSRF blocks mutation* | 🟥 (UI: `/automation` page TokenManager + ScheduleManager preset picker + next-run badge) |
| Sec 15, steps 39-41 | Export — Zephyr / TestRail / Playwright ZIP | UI: — · scaffolding: `functional-areas.spec.mjs` :: *project tests workflow: create, approve/reject/restore, export, run* | 🟥 (UI: ProjectExportMenu dropdown → file download triggers for each format) |
| Sec 16, steps 42-44 | AI Chat — multi-turn + export | — | 🟥 (UI: `/chat` page session create/rename/delete + Markdown/JSON export) |
| Sec 17, step 45 | Dashboard — pass-rate / defect breakdown | — | 🟥 (UI: Dashboard widgets render pass-rate + defect-breakdown charts with non-empty data) |
| Sec 18, steps 46-47 | Recycle bin — soft-delete + restore + audit log | — | 🟥 (UI: Settings → Recycle Bin restore/purge + Audit Log filter by user) |
| Sec 19, steps 48-49 | Account / GDPR — export + delete | — | 🟥 (UI: Settings → Account password-confirmed export download + 5s-disarm delete confirm) |
| Sec 20, steps 50-51 | Permissions — viewer 403, outsider 403 | UI: — · scaffolding: `full-functional-api.spec.mjs` :: *negative validations for project/test inputs* | 🟥 (UI: viewer role login → role-gated buttons hidden / clicking shows 403; outsider workspace URL redirect) |
 
---

## 🧪 Per-feature flows (`QA.md` § Functional Test Areas)

Per-feature happy paths that aren't part of the Golden journey. Can ship independently.
 
| QA.md section | Flow | Status |
|---|---|---|
| 🔐 Authentication | Forgot / reset password | 🟥 |
| 🔐 Authentication | Login rate-limit (429 after 5–10/15min) | 🟥 |
| 👥 Workspaces | Switch workspace | 🟥 |
| 📁 Projects | Edit project (`PATCH /projects/:id`, ENH-036) | 🟥 (UI: pencil-icon → `/projects/new?edit=<id>` form pre-filled, save round-trip) |
| 🧪 Tests Page | Bulk approve / reject | 🟥 (UI: Tests page checkbox-select + bulk action toolbar) |
| 🎥 Recorder | Captured action vocabulary (click/dblclick/etc.) | 🟥 |
| ▶️ Runs | Cross-browser (Firefox/WebKit) — DIF-002 | ✅ (UI-runner — `.github/workflows/cross-browser.yml` launches each engine) |
| 🪄 AI Fix | SSE stream consumption | 🟥 |
| ⚡ Automation | Trigger token create / list / revoke | 🟥 |
| ⚡ Automation | Schedule fire | 🟥 |
| 🖼️ Visual Testing | Baseline accept + diff | 🟥 |
| 📊 Dashboard | Empty workspace empty states | 🟥 |
| 🤖 AI Chat | Cross-workspace data-leak refusal | 🟥 |
| ⚙️ Settings | AI provider key save + restore | 🟥 |
| 👤 Account / GDPR | Export + delete | 🟥 |
| 📧 Email Verification | Resend + grandfathering | 🟥 (UI: Login page "verify your email" state + Resend button click) |
| ♻️ Recycle Bin | Restore + purge | 🟥 |
| 🧾 Audit Log | `userId` / `userName` per activity | 🟥 |
| 🔔 Notifications | At-least-one-channel validation | 🟥 |
| 🔒 Security | IDOR + cross-workspace 403 | 🟥 (UI: outsider hitting another workspace URL → redirect / 403 page) |
| 🚦 Quality Gates (AUTO-012) | CRUD + evaluator + trigger response | ✅ (UI: `quality-gates-ui.spec.mjs` covers Settings panel save round-trip + RunDetail gate badge + inline violation panel via `page.route()` mock of `/api/v1/runs/:runId`) |
| 📑 Reports / PDF | Dashboard PDF export | 🟥 |
| 🆕 New Project page | SSRF block on private URLs | 🟥 |
| 📋 Runs list | Filter by status / project | 🟥 |
| ☑️ Bulk actions | Keyboard shortcuts (`/`, `a`, `r`, `Esc`) | 🟥 (UI-only) |
| 🪟 Modals | Each modal open / close / submit | 🟥 (UI-only) |
| 📤 API imports | OpenAPI / HAR / `METHOD /path` | 🟥 |
| 🚀 Onboarding tour | First-login flow | 🟥 (UI-only) |
| 🎟️ Demo mode | Per-user quotas | 🟥 |
| ⚙️ Settings → Data | Clear runs / activities / healing | 🟥 |
