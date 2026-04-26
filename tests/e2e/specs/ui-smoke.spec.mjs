import { test, expect } from '../../../backend/node_modules/@playwright/test/index.mjs';
import { isReachable } from '../utils/environment.mjs';

test.describe('Sentri UI smoke (login route)', () => {
  test.skip(process.env.RUN_UI_E2E !== 'true', 'Set RUN_UI_E2E=true to run browser UI coverage.');

  test.beforeEach(async ({ page, baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, `Frontend is not reachable at ${baseURL}.`);
  });

  test('login page renders core controls', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: /login|sign in/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /login|sign in/i })).toBeVisible();

    await page.screenshot({ path: 'tests/e2e/artifacts/login-page.png', fullPage: true });
  });

  test('invalid credentials show an error state', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('invalid-user@example.com');
    await page.getByLabel(/password/i).fill('bad-password');
    await page.getByRole('button', { name: /login|sign in/i }).click();

    await expect(page.getByText(/invalid|incorrect|failed|error/i).first()).toBeVisible();
    await page.screenshot({ path: 'tests/e2e/artifacts/login-invalid.png', fullPage: true });
  });
});
