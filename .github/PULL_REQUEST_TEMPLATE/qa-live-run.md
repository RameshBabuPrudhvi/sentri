# QA Live Browser Run

> Use this template for PRs that record a live browser QA run of the deployed
> Sentri driven from `QA.md`. Pair with `qa-run-issues.md` at repo root.

## Summary

- **Run date:** `YYYY-MM-DD`
- **Target URL:** `https://rameshbabuprudhvi.github.io/sentri`
- **QA.md commit at run time:** `<sha>`
- **Issues found:** `<N>` (`<blockers>` blocker / `<major>` major / `<minor>` minor)
- **Issues fixed in this PR:** `<N>`
- **Issues deferred to follow-up:** `<N>` — see `qa-run-issues.md`

## Flow progress

- [ ] Authentication (`QA.md` 353–376)
- [ ] Workspaces (379–395)
- [ ] Projects (399–414)
- [ ] Tests Page — UI generation §3 (418–453)
- [ ] Recorder (457–475)
- [ ] Runs (478–501)
- [ ] AI Fix (504–527)
- [ ] Golden E2E Happy Path (240–339)

Mark a box only when the flow has either a passing UI test on the deployed URL
**or** a logged entry in `qa-run-issues.md`.

## QA.md doc fixes included

- [ ] `QA.md:27` anchor `#canonical-ui-test-shape--emit-this-by-default` resolves (heading promoted, or anchor dropped)
- [ ] `QA.md:38` vs `QA.md:83` bug-template line range matches (`1048–1081` in both)
- [ ] Emoji anchors in intent map (`QA.md:31-37`) verified on rendered GitHub, broken ones replaced with line ranges

## Generated tests

- [ ] All new tests follow the canonical UI shape at `QA.md:94-108`
  - `page.goto(...)`, role selectors, `safeClick` / `safeFill`, ≥ 3 `expect(page....)` assertions
- [ ] No `request.fetch` / `request.get` / `request.post` calls (unless the flow is explicitly an API test)
- [ ] Tests live under the repo's existing Playwright test path (confirm before creating new dirs)

## Mid-session resumability

- [ ] Last commit pushed; no local-only changes
- [ ] PR description "Flow progress" reflects actual state
- [ ] `qa-run-issues.md` summary table sorted by severity
- [ ] Resume note in latest PR comment: last-completed step + next step

## Standard checklist

- [ ] PR title follows Conventional Commits (`qa:` or `docs(qa):`)
- [ ] Branch is off `develop`, not `main`
- [ ] CI green
- [ ] No secrets, API keys, or credentials in the diff
