import { test, expect } from '../utils/playwright.mjs';
import { isReachable } from '../utils/environment.mjs';

/**
 * UI E2E coverage for AUTO-012 Quality Gates — Settings panel save round-trip.
 *
 * Drives the browser through ProjectDetail → Settings → QualityGatesPanel, fills
 * `minPassRate`, clicks Save, asserts the success toast, reloads, and confirms
 * the value persisted — all via rendered DOM (no API read-back), per
 * `tests/e2e/COVERAGE.md` § UI-only policy.
 *
 * NOTE: The Runs-list `GateBadge` and RunDetail violation-panel flows are
 * deliberately **not** covered here — they require a persisted run with
 * `gateResult.passed === false`, which can only be produced by a real test run
 * (no test-only seeding endpoint exists). Those rows stay 🟥 on COVERAGE.md
 * until either a seeding helper is added or the spec is extended to drive a
 * full crawl → approve → run flow end-to-end.
 *
 * API calls in `beforeAll` are scaffolding only (register + login + create
 * project) so the UI test can jump straight to the Settings panel.
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
});
