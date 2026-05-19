# Browser code coverage mapping (AUTO-009)

AUTO-009 adds opt-in browser JavaScript coverage capture during Playwright runs.

## Enable / disable per project

1. Go to **Automation → Quality → Coverage**.
2. Toggle **Enable browser JS coverage capture**.
3. Optionally set `sourcemapBaseUrl` if maps are hosted on a separate CDN.

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
