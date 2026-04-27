# QA Live-Run Issues

> Template for tracking issues found during a live browser QA run against the
> deployed Sentri (`https://rameshbabuprudhvi.github.io/sentri`) driven from
> `QA.md`. One row per issue. Keep the summary table in sync with the detailed
> entries below.
>
> **Workflow:** during a run, append a detailed entry first, then add a one-line
> row to the summary table. At the end of the run, sort the summary by severity
> (blocker → major → minor).

## Run metadata

- **Run date:** `YYYY-MM-DD`
- **Runner:** `<agent or human>`
- **Branch:** `qa/live-browser-run-YYYY-MM-DD`
- **Target URL:** `https://rameshbabuprudhvi.github.io/sentri`
- **QA.md commit:** `<sha>`
- **Playwright version:** `<x.y.z>`

## Summary

| # | Severity | Flow | QA.md § (lines) | One-line observation | Owner |
|---|---|---|---|---|---|
| 1 | blocker / major / minor | Authentication | `authentication` (353–376) | e.g. "Sign-in button has no accessible name" | frontend |

## Flow status

| Flow | QA.md lines | Status | Notes |
|---|---|---|---|
| Authentication | 353–376 | ⬜ pending / 🟡 in progress / ✅ pass / ❌ issues | |
| Workspaces | 379–395 | ⬜ | |
| Projects | 399–414 | ⬜ | |
| Tests Page (UI generation §3) | 418–453 | ⬜ | |
| Recorder | 457–475 | ⬜ | |
| Runs | 478–501 | ⬜ | |
| AI Fix | 504–527 | ⬜ | |
| Golden E2E Happy Path | 240–339 | ⬜ | |

## Issues (detailed)

### Issue 1 — `<short title>`

- **Severity:** blocker / major / minor
- **Flow:** `<flow name>`
- **QA.md section:** `<anchor>` (lines `A–B`)
- **Observed:** what actually happened
- **Expected:** what `QA.md` says should happen
- **Repro steps:**
  1. `await page.goto('https://rameshbabuprudhvi.github.io/sentri/...')`
  2. `<selector / action>`
  3. `<assertion that failed>`
- **Console / network excerpt:**
  ```
  <paste relevant log lines, redact tokens>
  ```
- **Screenshot:** `artifacts/run-YYYY-MM-DD/issue-1.png`
- **Proposed fix owner:** frontend / backend / docs
- **Proposed fix sketch:** one or two lines, no code change required here
- **Status:** open / fixed-in-this-pr / deferred-to-followup

<!-- Duplicate the block above for each subsequent issue. -->
