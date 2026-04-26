import { test, expect } from '../utils/playwright.mjs';
import { isReachable } from '../utils/environment.mjs';

test.describe('Sentri UI smoke (login route)', () => {
  test.skip(process.env.RUN_UI_E2E !== 'true', 'Set RUN_UI_E2E=true to run browser UI coverage.');

  test.beforeEach(async ({ page, baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, `Frontend is not reachable at ${baseURL}.`);
  });

  test('login page renders core controls', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /password/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /login|sign in/i }).first()).toBeVisible();

    await page.screenshot({ path: 'tests/e2e/artifacts/login-page.png', fullPage: true });
  });

  test('invalid credentials show an error state', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill('invalid-user@example.com');
    await page.getByRole('textbox', { name: /password/i }).fill('bad-password');
    await page.getByRole('button', { name: /login|sign in/i }).first().click();

    await expect(page.getByText(/invalid|incorrect|failed|error/i).first()).toBeVisible();
    await page.screenshot({ path: 'tests/e2e/artifacts/login-invalid.png', fullPage: true });
  });
});
