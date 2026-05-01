import { test, expect } from '../utils/playwright.mjs';
import { isReachable } from '../utils/environment.mjs';

/**
 * UI E2E coverage for AUTO-012 Quality Gates.
 *
 * Two tests, both driving rendered DOM via `expect(page.…)` per the
 * `REVIEW.md` § Mandatory Test Requirements rule:
 *
 *   1. Settings → QualityGatesPanel save round-trip — fills `minPassRate`,
 *      clicks Save, asserts the success toast, reloads, and confirms the
 *      value persisted.
 *   2. RunDetail gate badge + violation panel — uses Playwright `page.route()`
 *      to intercept the run-detail API call and inject a synthetic
 *      `gateResult: { passed: false, violations: [...] }` payload, then
 *      asserts the red `Gates ✗` badge and the inline violation panel
 *      (rule / threshold / actual values) render. This avoids the heavy
 *      approved-test → real-run → real-failure fixture chain that would
 *      otherwise be needed to produce a sub-gate run, while still asserting
 *      against the actual rendered DOM. Tier 3 of `tests/e2e/COVERAGE.md`
 *      explicitly endorses `route()` mocks for run-related UI specs.
 *
 * API calls in `beforeAll` are scaffolding only (register + login + create
 * project) so the UI tests can jump straight to the page under test.
 */
test.describe('Quality Gates UI (AUTO-012) — Settings panel', () => {
  test.skip(process.env.RUN_UI_E2E !== 'true', 'Set RUN_UI_E2E=true to run browser UI coverage.');

  let projectId;
  let email;
  const password = 'Password123!';

  test.beforeAll(async ({ request, baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    if (!ok) return;

    email = `qa-gates-${Date.now()}@example.com`;

    // Scaffolding: register + login + create project via API.
    await request.post('/api/auth/register', { data: { name: 'QA', email, password } });
    await request.post('/api/auth/login', { data: { email, password } });

    const project = await request.post('/api/v1/projects', {
      data: { name: 'Gates Project', url: 'https://example.com' },
    });
    if (project.ok()) projectId = (await project.json()).id;
  });

  test('Settings → Quality Gates panel saves and persists minPassRate', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    // Log in through the UI so cookies are set on the browser context.
    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();

    await page.goto(`/projects/${projectId}`);

    // Tabs render as <button class="pd-tab"> (see ProjectDetail.jsx:361) —
    // use `getByRole('button', …)` rather than `role=tab`.
    await page.getByRole('button', { name: /^settings$/i }).click();

    await expect(page.getByRole('heading', { name: /quality gates/i })).toBeVisible();
    await page.getByLabel(/min pass rate/i).fill('95');
    await page.getByRole('button', { name: /^save$/i }).click();

    await expect(page.getByText(/quality gates saved/i)).toBeVisible();

    // Reload and verify persistence through the GET round-trip.
    await page.reload();
    await page.getByRole('button', { name: /^settings$/i }).click();
    await expect(page.getByLabel(/min pass rate/i)).toHaveValue('95');
    await expect(page.getByText(/^active$/i).first()).toBeVisible();
  });

  test('RunDetail renders Gates ✗ badge and violation panel for a sub-gate run', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    // Log in through the UI so cookies are set on the browser context.
    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();

    // Synthetic run id — the route handler below intercepts the GET so this
    // never actually hits the backend, but RunDetail still renders against
    // the injected payload.
    const fakeRunId = 'RUN-AUTO012-UITEST';

    // Intercept the run-detail API call. The frontend fetches via the
    // versioned `/api/v1/runs/:runId` endpoint (see `frontend/src/api.js`
    // `getRun`); match either the prefixed or unprefixed path so this stays
    // robust against the api.js base-path config.
    await page.route(/\/api\/(v1\/)?runs\/RUN-AUTO012-UITEST(\?.*)?$/, async (route) => {
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
          total: 10,
          passed: 9,
          failed: 1,
          results: [],
          logs: [],
          gateResult: {
            passed: false,
            violations: [
              { rule: 'minPassRate', threshold: 95, actual: 90 },
            ],
          },
        }),
      });
    });

    await page.goto(`/runs/${fakeRunId}`);

    // Header badge — `<GateBadge>` renders "Gates ✗" + violation count when
    // `gateResult.passed === false` (see `frontend/src/components/shared/GateBadge.jsx`).
    await expect(page.getByText(/gates ✗/i).first()).toBeVisible();

    // Inline violation panel on RunDetail — heading + per-rule line.
    await expect(page.getByText(/quality gate failed/i)).toBeVisible();
    await expect(page.getByText('minPassRate')).toBeVisible();
    // Threshold + actual values render as <strong>{v.threshold}</strong> /
    // <strong>{v.actual}</strong> alongside the rule name in the same row.
    await expect(page.getByText(/threshold/i).first()).toBeVisible();
  });
});
