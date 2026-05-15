import { test, expect } from '../utils/playwright.mjs';
import { isReachable } from '../utils/environment.mjs';

/**
 * UI E2E coverage for CAP-001 Data-driven test fixtures.
 *
 * Three tests, all driving rendered DOM via `expect(page.…)` per the
 * `REVIEW.md` § Mandatory Test Requirements rule and `tests/e2e/COVERAGE.md`
 * § UI-only policy:
 *
 *   1. TestDetail → TestFixturePanel CSV upload round-trip — drives the
 *      Data-driven fixtures panel, fills the CSV textarea, clicks
 *      "Save fixture", asserts the success line, and confirms the new row
 *      lands in the history table with an "active" badge.
 *   2. RunDetail renders the `iteration #N` badge from a 3-row fixture run
 *      — uses Playwright `page.route()` to intercept the run-detail API
 *      and inject a synthetic run whose results carry `iterationIndex` +
 *      `fixtureRow`. Avoids the heavy fixture → real-runner → DOM chain
 *      while still asserting the actual rendered badge.
 *   3. ProjectQualityCard → Iterations panel save round-trip — proves the
 *      per-project `iterationCap` PATCH bypass + UI plumbing works.
 *
 * API calls (register + login + create project + seed test) are scaffolding
 * only so the UI tests can jump straight to the page under test. The
 * `page.route()` mock pattern is endorsed by Tier 3 of
 * `tests/e2e/COVERAGE.md` for run-related UI specs.
 */
test.describe('Data-driven fixtures UI (CAP-001)', () => {
  test.skip(process.env.RUN_UI_E2E !== 'true', 'Set RUN_UI_E2E=true to run browser UI coverage.');

  let projectId;
  let testId;
  let email;
  const password = 'Password123!';

  test.beforeAll(async ({ request, baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    if (!ok) return;

    email = `qa-fixtures-${Date.now()}@example.com`;

    // Scaffolding: register + login + create project + seed an approved
    // test via API so the UI test can land on `/tests/:testId` directly.
    await request.post('/api/auth/register', { data: { name: 'QA', email, password } });
    await request.post('/api/auth/login', { data: { email, password } });

    const projectRes = await request.post('/api/v1/projects', {
      data: { name: 'Fixtures Project', url: 'https://example.com' },
    });
    if (!projectRes.ok()) return;
    projectId = (await projectRes.json()).id;

    // Manual-test creation endpoint accepts a Playwright body so the test
    // is immediately runnable with placeholders for the fixture panel
    // to substitute against.
    const testRes = await request.post(`/api/v1/projects/${projectId}/tests`, {
      data: {
        name: 'Fixture target',
        description: 'Seeded for CAP-001 UI coverage',
        steps: ['User logs in as {{email}}'],
        playwrightCode:
          "test('fixture target', async ({ page }) => { await page.goto('https://example.com?u={{email}}'); });",
        priority: 'medium',
      },
    });
    if (testRes.ok()) testId = (await testRes.json()).id;
  });

  async function uiLogin(page) {
    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();
  }

  test('TestDetail → fixture panel saves a CSV upload and renders it in history', async ({ page, baseURL }) => {
    test.skip(!testId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    await uiLogin(page);
    await page.goto(`/tests/${testId}`);

    // Panel headline + version badge (`v1` for a freshly created test).
    await expect(page.getByRole('heading', { name: /data-driven fixtures/i })).toBeVisible();

    // Format select defaults to "CSV" — fill the CSV textarea and save.
    // The textarea is the only `<textarea>` rendered with the CSV
    // placeholder, so target it via its placeholder string.
    await page.getByPlaceholder(/email,role/i).fill(
      'email,role\na@example.com,admin\nb@example.com,viewer\nc@example.com,viewer',
    );
    await page.getByRole('button', { name: /save fixture/i }).click();

    // Success line — see TestFixturePanel.jsx:67 ("Saved N row(s) at version M").
    await expect(page.getByText(/saved\s+3\s+row\(s\)\s+at\s+version\s+1/i)).toBeVisible();

    // History table row for v1 with the `active` badge (matches
    // current codeVersion).
    await expect(page.getByText('CSV')).toBeVisible();
    await expect(page.getByText(/^active$/i).first()).toBeVisible();
  });

  test('RunDetail renders iteration #N badges for a 3-row fixture run', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    await uiLogin(page);

    // Synthetic run id — the route handler below intercepts the GET so
    // this never actually hits the backend. Acceptance criterion: a
    // 3-row fixture produces 3 iteration results, each surfaced with
    // its own badge.
    const fakeRunId = 'RUN-CAP001-UITEST';
    const rows = [
      { email: 'a@example.com', role: 'admin' },
      { email: 'b@example.com', role: 'viewer' },
      { email: 'c@example.com', role: 'viewer' },
    ];

    await page.route(/\/api\/(v1\/)?runs\/RUN-CAP001-UITEST(\?.*)?$/, async (route) => {
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
          passed: 2,
          failed: 1,
          logs: [],
          results: rows.map((row, i) => ({
            testId: testId || 'TST-FIX-1',
            testName: 'Fixture target',
            status: i === 1 ? 'failed' : 'passed',
            error: i === 1 ? 'assertion failed on row 2' : null,
            durationMs: 120,
            network: [],
            consoleLogs: [],
            iterationIndex: i,
            fixtureRow: row,
          })),
        }),
      });
    });

    await page.goto(`/runs/${fakeRunId}`);

    // Each iteration result emits its own badge — `iteration #1`, #2, #3.
    // The badges live inside StepResultsView and use the substituted row
    // JSON as their tooltip (`title` attr).
    await expect(page.getByText(/iteration #1/i)).toBeVisible();
    await expect(page.getByText(/iteration #2/i)).toBeVisible();
    await expect(page.getByText(/iteration #3/i)).toBeVisible();
  });

  test('Automation → Iterations panel saves a per-project iteration cap', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    await uiLogin(page);
    await page.goto('/automation');

    // The Iterations tab lives inside ProjectQualityCard (Automation →
    // Quality Gates section). Expand the project accordion first, then
    // click into the Iterations inner tab.
    await page.getByText('Fixtures Project').first().click();
    await page.getByRole('button', { name: /^iterations$/i }).first().click();

    // Fill the cap input and save. The placeholder anchors the input.
    const capInput = page.getByPlaceholder(/e\.g\. 25/i).first();
    await capInput.fill('25');
    await page.getByRole('button', { name: /^save$/i }).click();

    // Toast / success message — see IterationCapPanel onToast call.
    await expect(page.getByText(/iteration cap set to 25/i)).toBeVisible();

    // Reload and confirm persistence.
    await page.reload();
    await page.getByText('Fixtures Project').first().click();
    await page.getByRole('button', { name: /^iterations$/i }).first().click();
    await expect(page.getByPlaceholder(/e\.g\. 25/i).first()).toHaveValue('25');
  });
});
