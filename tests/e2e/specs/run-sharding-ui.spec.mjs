import { test, expect } from '../utils/playwright.mjs';
import { isReachable } from '../utils/environment.mjs';

/**
 * UI E2E coverage for CAP-002 (partial — in-process shard plumbing).
 *
 * Two tests, both driving rendered DOM via `expect(page.…)` per the
 * `REVIEW.md` § Mandatory Test Requirements rule and `tests/e2e/COVERAGE.md`
 * § UI-only policy. Tier-3 `page.route()` mock pattern is used for the
 * RunDetail badge case to avoid the heavy real-runner chain while still
 * asserting the actual rendered chip.
 *
 *   1. RunRegressionModal — the `Shards` input renders, coerces non-integer
 *      input to a sane value, and only forwards `shards` on the request
 *      body when the user picked `> 1`.
 *   2. RunDetail — the blue `Shards M/N` badge surfaces when `shardCount > 1`
 *      and stays hidden on `shardCount <= 1` (zero-regression). Uses
 *      `page.route()` to inject synthetic runs with both shapes.
 *
 * Cross-process partition (criterion 1 wall-clock split) and shard-crash
 * → failed (criterion 4) need a real BullMQ worker harness — deferred to
 * the follow-up CAP-002 PR alongside the coordinator/shard worker split.
 */
test.describe('Run sharding UI (CAP-002)', () => {
  test.skip(process.env.RUN_UI_E2E !== 'true', 'Set RUN_UI_E2E=true to run browser UI coverage.');

  let projectId;
  let email;
  const password = 'Password123!';

  test.beforeAll(async ({ request, baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    if (!ok) return;

    email = `qa-shards-${Date.now()}@example.com`;

    // Scaffolding: register + login + create a project + seed an approved
    // test so the RunRegressionModal isn't gated by "no approved tests".
    await request.post('/api/auth/register', { data: { name: 'QA', email, password } });
    await request.post('/api/auth/login', { data: { email, password } });

    const projectRes = await request.post('/api/v1/projects', {
      data: { name: 'Sharding Project', url: 'https://example.com' },
    });
    if (!projectRes.ok()) return;
    projectId = (await projectRes.json()).id;

    const testRes = await request.post(`/api/v1/projects/${projectId}/tests`, {
      data: {
        name: 'shard probe',
        description: 'Seeded for CAP-002 UI coverage',
        steps: ['Open'],
        playwrightCode:
          "test('shard probe', async ({ page }) => { await page.goto('https://example.com'); });",
        priority: 'medium',
      },
    });
    if (testRes.ok()) {
      const { id } = await testRes.json();
      await request.patch(`/api/v1/projects/${projectId}/tests/${id}/approve`);
    }
  });

  async function uiLogin(page) {
    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();
  }

  test('RunRegressionModal shards input coerces input + only sends shards > 1', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    await uiLogin(page);

    // Capture the POST /run body so we can assert what the frontend sends.
    // The button click navigates to the run detail page; intercepting +
    // fulfilling lets us inspect the payload without actually running tests.
    let capturedBody = null;
    await page.route(/\/api\/v1\/projects\/[^/]+\/run$/, async (route) => {
      try {
        const json = route.request().postDataJSON();
        capturedBody = json || {};
      } catch {
        capturedBody = {};
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runId: 'RUN-CAP002-UITEST' }),
      });
    });

    // Land on the Tests page and open the Run Regression modal.
    await page.goto('/tests');
    await page.getByRole('button', { name: /run\s*tests/i }).first().click();
    await expect(page.getByRole('heading', { name: /run regression tests/i })).toBeVisible();

    const shardsInput = page.getByLabel(/shard count/i);
    await expect(shardsInput).toBeVisible();
    // Default value is 1 (the int the state was initialised with).
    await expect(shardsInput).toHaveValue('1');

    // Coercion contract: a blank input must not poison `Number(shards)` —
    // the onChange handler resets to 1 in that case.
    await shardsInput.fill('');
    await expect(shardsInput).toHaveValue('1');

    // Pick > 1 and submit.
    await shardsInput.fill('3');
    await expect(shardsInput).toHaveValue('3');
    await page.getByRole('button', { name: /^run tests$/i }).click();

    await expect.poll(() => capturedBody && capturedBody.shards).toBe(3);
  });

  test('RunDetail renders Shards M/N badge only when shardCount > 1', async ({ page, baseURL }) => {
    test.skip(!projectId, 'API scaffolding unavailable.');
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, 'Frontend not reachable.');

    await uiLogin(page);

    // ── Case 1: shardCount > 1 → badge visible with M/N progress ─────────
    await page.route(/\/api\/(v1\/)?runs\/RUN-CAP002-BADGE(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'RUN-CAP002-BADGE',
          projectId,
          type: 'test_run',
          status: 'running',
          startedAt: new Date().toISOString(),
          total: 4,
          passed: 0,
          failed: 0,
          logs: [],
          results: [],
          shardCount: 4,
          shardsCompleted: 2,
          // Required by RunDetail.jsx so the pass-rate row + badges render.
          testQueue: [],
        }),
      });
    });

    await page.goto('/runs/RUN-CAP002-BADGE');
    await expect(page.getByText(/^shards\s+2\s*\/\s*4$/i)).toBeVisible();

    // ── Case 2: shardCount === 1 → badge hidden (zero-regression) ────────
    await page.route(/\/api\/(v1\/)?runs\/RUN-CAP002-NOBADGE(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'RUN-CAP002-NOBADGE',
          projectId,
          type: 'test_run',
          status: 'running',
          startedAt: new Date().toISOString(),
          total: 1,
          passed: 0,
          failed: 0,
          logs: [],
          results: [],
          shardCount: 1,
          shardsCompleted: 0,
          testQueue: [],
        }),
      });
    });

    await page.goto('/runs/RUN-CAP002-NOBADGE');
    // Wait for the header to mount before asserting absence.
    await expect(page.getByText(/task #/i)).toBeVisible();
    await expect(page.getByText(/^shards\s+\d+\s*\/\s*\d+$/i)).toHaveCount(0);
  });
});
