import { test, expect } from '../utils/playwright.mjs';
import { isReachable } from '../utils/environment.mjs';

/**
 * UI E2E coverage for DIF-012 Multi-environment support.
 *
 * Two tests driving rendered DOM per `REVIEW.md` § Mandatory Test
 * Requirements:
 *
 *   1. ProjectDetail → Environments tab CRUD round-trip — adds a `staging`
 *      environment, asserts the row renders with the supplied baseUrl, then
 *      reloads to confirm persistence through the API GET.
 *   2. RunRegressionModal environment dropdown — uses Playwright
 *      `page.route()` to inject a synthetic environments list onto the
 *      project so the dropdown surfaces without requiring a real run
 *      against staging. Tier-2 of `tests/e2e/COVERAGE.md` endorses this
 *      mock-first pattern for cross-cutting modal flows.
 *
 * API calls in `beforeAll` are scaffolding only (register + login + create
 * project) so the UI tests can jump straight to the page under test.
 */
test.describe('Environments UI (DIF-012) — ProjectDetail tab + Run modal', () => {
  test.skip(process.env.RUN_UI_E2E !== 'true', 'Set RUN_UI_E2E=true to run browser UI coverage.');

  let projectId;
  let email;
  const password = 'Password123!';

  test.beforeAll(async ({ request, baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    if (!ok) return;

    email = `qa-envs-${Date.now()}@example.com`;

    await request.post('/api/auth/register', { data: { name: 'QA', email, password } });
    await request.post('/api/auth/login', { data: { email, password } });

    const project = await request.post('/api/v1/projects', {
      data: { name: 'Multi-env Project', url: 'https://prod.example.com' },
    });
    if (project.ok()) projectId = (await project.json()).id;
  });

  test('Environments tab creates a staging row and persists across reload', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();

    await page.goto(`/projects/${projectId}`);
    await page.getByRole('button', { name: /^environments$/i }).click();

    await expect(page.getByRole('heading', { name: /environments/i })).toBeVisible();
    // Empty-state copy
    await expect(page.getByText(/no environments defined/i)).toBeVisible();

    // Fill the add-environment form.
    await page.getByLabel(/^name$/i).fill('staging');
    await page.getByLabel(/^base url$/i).fill('https://staging.example.com');
    await page.getByRole('button', { name: /add environment/i }).click();

    // Row should appear with the supplied baseUrl.
    await expect(page.getByRole('cell', { name: 'staging' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'https://staging.example.com' })).toBeVisible();

    // Reload → tab still on default → re-click → confirm persistence through GET.
    await page.reload();
    await page.getByRole('button', { name: /^environments$/i }).click();
    await expect(page.getByRole('cell', { name: 'staging' }).first()).toBeVisible();
  });

  test('RunRegressionModal exposes the environment dropdown when envs exist', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();

    // Inject a synthetic environments list so the dropdown appears even on
    // a fresh project state. Matches both prefixed and unprefixed paths to
    // stay robust against the api.js base-path config.
    await page.route(/\/api\/(v1\/)?projects\/[^/]+\/environments(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'ENV-stg-1', projectId, name: 'staging', baseUrl: 'https://staging.example.com', credentials: null, createdAt: new Date().toISOString() },
          { id: 'ENV-prod-1', projectId, name: 'production', baseUrl: 'https://prod.example.com', credentials: null, createdAt: new Date().toISOString() },
        ]),
      });
    });

    await page.goto('/runs');
    // Open the Run Regression modal — the trigger button label varies
    // slightly across pages, match broadly.
    await page.getByRole('button', { name: /run.*regression|run tests/i }).first().click();

    // Dropdown label + the two synthetic options should render.
    await expect(page.getByText(/^environment$/i).first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: /environment/i })).toBeVisible();
    const envSelect = page.locator('select').filter({ hasText: /default \(project url\)/i }).first();
    await expect(envSelect).toBeVisible();
    await expect(envSelect.locator('option', { hasText: 'staging' })).toHaveCount(1);
    await expect(envSelect.locator('option', { hasText: 'production' })).toHaveCount(1);
  });
});
