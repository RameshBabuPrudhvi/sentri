import { test, expect } from '../utils/playwright.mjs';
import { isReachable } from '../utils/environment.mjs';

/**
 * AUTO-009 / AUTO-009k — UI E2E coverage for the browser code-coverage feature.
 *
 * Three tests, all driving rendered DOM via `expect(page.…)` per the
 * REVIEW.md § Mandatory Test Requirements rule:
 *
 *   1. Dashboard CoveragePanel — uses Playwright `page.route()` to inject
 *      a synthetic `coverageTrend` + `latestCoverageByProject` payload into
 *      the dashboard API response, then asserts the per-project sparkline
 *      and "Top uncovered files" list render.
 *   2. RunDetail per-test `+N lines` badge — intercepts the run-detail GET
 *      with a synthetic `coverageSummary.perTest` payload and asserts the
 *      blue delta badge appears next to the test row.
 *   3. Automation → Quality → Coverage tab — clicks the toggle, asserts the
 *      PATCH fires with `coverageEnabled: true`.
 *
 * Tier 3 of `tests/e2e/COVERAGE.md` explicitly endorses `route()` mocks for
 * coverage-related UI specs — the alternative (running a real browser test
 * against a real SUT with source maps) is heavy fixture chain we can't
 * sustain in CI yet.
 */
test.describe('Coverage UI (AUTO-009) — Dashboard + RunDetail + ProjectQualityCard', () => {
  test.skip(process.env.RUN_UI_E2E !== 'true', 'Set RUN_UI_E2E=true to run browser UI coverage.');

  let projectId;
  let email;
  const password = 'Password123!';

  test.beforeAll(async ({ request, baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    if (!ok) return;

    email = `qa-coverage-${Date.now()}@example.com`;

    // Scaffolding: register + login + create project via API so we can
    // toggle `coverageEnabled` against a real project row.
    await request.post('/api/auth/register', { data: { name: 'QA', email, password } });
    await request.post('/api/auth/login', { data: { email, password } });

    const project = await request.post('/api/v1/projects', {
      data: { name: 'Coverage Project', url: 'https://app.example.com' },
    });
    if (project.ok()) projectId = (await project.json()).id;
  });

  test('Dashboard renders Coverage panel with sparkline + Top uncovered files', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    // Log in through the UI so cookies are set on the browser context.
    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();

    // Intercept the dashboard payload. The CoveragePanel reads `coverageTrend`
    // (30-day sparkline) and `latestCoverageByProject` (top-uncovered list)
    // from the same /dashboard response — see `routes/dashboard.js` and
    // `frontend/src/pages/Dashboard.jsx`.
    await page.route(/\/api\/(v1\/)?dashboard(\?.*)?$/, async (route) => {
      const now = Date.now();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalProjects: 1,
          totalTests: 5,
          totalRuns: 3,
          passRate: 92,
          history: [], recentRuns: [],
          runsByStatus: { completed: 3, failed: 0, aborted: 0, running: 0 },
          testsByReview: { draft: 0, approved: 5, rejected: 0 },
          coverageTrend: {
            windowDays: 30,
            series: [
              { date: new Date(now - 2 * 86_400_000).toISOString(), projectId, coveragePct: 0.72 },
              { date: new Date(now - 1 * 86_400_000).toISOString(), projectId, coveragePct: 0.78 },
              { date: new Date(now).toISOString(),                  projectId, coveragePct: 0.81 },
            ],
          },
          latestCoverageByProject: {
            [projectId]: {
              coveragePct: 0.81,
              totalLines: 1200,
              coveredLines: 972,
              topUncoveredFiles: [
                { file: 'src/components/Cart.tsx', uncoveredLines: 47, totalLines: 200 },
                { file: 'src/auth/middleware.ts',  uncoveredLines: 31, totalLines: 80 },
              ],
              sourceMapStatus: 'resolved',
            },
          },
        }),
      });
    });

    await page.goto('/dashboard');

    // Coverage panel section title renders inside CoveragePanel.
    await expect(page.getByText(/^coverage$/i).first()).toBeVisible();
    // "30-day · N runs" sub-label.
    await expect(page.getByText(/30-day/i)).toBeVisible();
    // Latest coverage badge — `Math.round(0.81 * 100)` = 81%.
    await expect(page.getByText('81%').first()).toBeVisible();
    // Top uncovered files list.
    await expect(page.getByText('src/components/Cart.tsx')).toBeVisible();
    await expect(page.getByText('src/auth/middleware.ts')).toBeVisible();
  });

  test('RunDetail renders +N lines badge from coverageSummary.perTest', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();

    const fakeRunId = 'RUN-AUTO009-UITEST';
    const fakeTestId = 'TEST-AUTO009-001';

    await page.route(/\/api\/(v1\/)?runs\/RUN-AUTO009-UITEST(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: fakeRunId,
          projectId,
          type: 'test_run',
          status: 'completed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          total: 1,
          passed: 1,
          failed: 0,
          results: [
            { testId: fakeTestId, testName: 'covers main.js', status: 'passed', durationMs: 1234, steps: [] },
          ],
          logs: [],
          coverageSummary: {
            coveragePct: 0.65,
            totalLines: 200, coveredLines: 130,
            perTest: [
              { testId: fakeTestId, deltaLines: 47, deltaPct: 0.235 },
            ],
            topUncoveredFiles: [],
            sourceMapStatus: 'fallback',
          },
        }),
      });
    });

    await page.goto(`/runs/${fakeRunId}`);

    // Test row renders with the `+47 lines` blue badge — see
    // `frontend/src/components/run/TestRunView.jsx` TestCaseRow.
    await expect(page.getByText('+47 lines')).toBeVisible();
  });

  test('ProjectQualityCard → Coverage tab toggles coverageEnabled via PATCH', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();

    // Capture the PATCH body so we can assert `coverageEnabled: true` was
    // sent. The handler still forwards to the real backend so the row
    // actually persists — this isn't a route mock, it's an observer.
    let patchBody = null;
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && /\/api\/(v1\/)?projects\/[^/]+$/.test(req.url())) {
        try { patchBody = req.postDataJSON(); } catch { /* ignore non-JSON */ }
      }
    });

    await page.goto('/automation');

    // Navigate to the project's Quality card → Coverage inner tab. The
    // Automation page uses accordion rows per project; expand the row and
    // click the Coverage tab (`ProjectQualityCard.jsx` ships the tab).
    const projectRow = page.getByText('Coverage Project').first();
    await projectRow.click();
    await page.getByRole('button', { name: /^coverage$/i }).click();

    // Toggle the "Enable browser JS coverage capture" checkbox.
    const enableCheckbox = page.getByLabel(/enable browser js coverage capture/i);
    await expect(enableCheckbox).toBeVisible();
    await enableCheckbox.check();

    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText(/coverage settings saved/i)).toBeVisible();

    // The captured PATCH must have `coverageEnabled: true` — the entire
    // contract the feature ships on.
    expect(patchBody?.coverageEnabled).toBe(true);
  });
});
