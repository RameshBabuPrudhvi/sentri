# Browser code coverage mapping (AUTO-009)

AUTO-009 adds opt-in browser JavaScript coverage capture during Playwright runs.

## Enable / disable per project

1. Open the project page and click **Settings** (top-right, alongside the **CI/CD** button).
2. In the project-settings sidebar, click **Quality Gates** under the **Quality** group.
3. Scroll to the **Coverage** section.
4. Toggle **Enable browser JS coverage capture**.
5. Optionally set the **Source-map base URL** field if maps are hosted on a separate CDN.

> The Coverage configuration used to live at **Automation → Quality → Coverage**; it
> moved to the project-scoped Settings surface (`/projects/:id/settings/quality-gates`)
> in the May 2026 restructure. Legacy `?tab=quality` deep-links redirect automatically.

## How to interpret results

- `run.coverageSummary.coveragePct`: project run coverage ratio in `[0,1]`.
- `perTest[].deltaLines`: lines first exercised by that test in the run.
- `topUncoveredFiles[]`: largest uncovered files (capped at 20).

## Source-map prerequisites

- If source maps are present and resolvable, file/line labels are cleaner.
- When maps are missing/malformed/unreachable, Sentri falls back to raw bundle
  coordinates and sets `coverageSummary.sourceMapStatus = "fallback"`.

## Performance expectations

- Coverage is **opt-in** and disabled by default.
- Enabling coverage adds runtime overhead; target budget is <= 1.3x wall clock
  for a representative 50-test run versus coverage disabled.
