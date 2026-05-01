import { test, expect } from '../utils/playwright.mjs';
import { isReachable } from '../utils/environment.mjs';
import * as userRepo from '../../../backend/src/database/repositories/userRepo.js';
import * as verificationTokenRepo from '../../../backend/src/database/repositories/verificationTokenRepo.js';
import { loginWithRetry, registerUser } from '../utils/auth.mjs';
import { SessionClient } from '../utils/session.mjs';

/**
 * UI E2E coverage for `QA.md` §3 step 5 — Project create via UI form.
 *
 * Drives the browser through `/projects/new`, fills name + URL, submits, and
 * asserts the redirect to `/projects/:id` plus the project's visibility in the
 * `/projects` list — all via rendered DOM (no API read-back), per
 * `tests/e2e/COVERAGE.md` § UI-only policy.
 *
 * API calls (register + verify) are scaffolding only so the UI test can jump
 * straight to the create form. Auth helpers come from `utils/auth.mjs` +
 * `utils/session.mjs` per AGENT.md "no custom auth/CSRF logic in specs".
 */
test.describe('Project create UI (QA.md §3 step 5)', () => {
  test.skip(process.env.RUN_UI_E2E !== 'true', 'Set RUN_UI_E2E=true to run browser UI coverage.');

  test.beforeEach(async ({ baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    test.skip(!ok, `Frontend is not reachable at ${baseURL}.`);
  });

  test('verified user can create a project via the form and see it in the list', async ({ page, request }) => {
    const api = new SessionClient(request);
    const { email, password } = await registerUser(request);
    const user = userRepo.getByEmail(email);
    expect(user).toBeTruthy();

    // CI sets SKIP_EMAIL_VERIFICATION=true (see .github/workflows/ci.yml), in which
    // case `backend/src/routes/auth.js` short-circuits before creating a
    // verificationTokens row and the user is already `emailVerified=1`. Only walk
    // the token → /verify round-trip when verification is actually pending.
    const tokenRow = verificationTokenRepo.getUnusedByUserId(user.id);
    if (tokenRow?.token) {
      const verifyResponse = await api.call('get', `/api/v1/auth/verify?token=${encodeURIComponent(tokenRow.token)}`);
      expect(verifyResponse.status()).toBe(200);
    } else {
      expect(user.emailVerified).toBeTruthy();
    }

    const loginResponse = await loginWithRetry(request, email, password);
    if (loginResponse.status() === 429) test.skip(true, 'Rate-limited in shared local environment');
    expect(loginResponse.status()).toBe(200);

    // Sign in through the UI so cookies land on the browser context.
    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).first().click();
    await expect(page).toHaveURL(/\/dashboard/);

    // Drive the create form. NewProject.jsx uses placeholder text rather than
    // <label htmlFor>, so target inputs by placeholder.
    const projectName = `E2E Project ${Date.now()}`;
    await page.goto('/projects/new');
    await page.getByPlaceholder(/My Web App/i).fill(projectName);
    await page.getByPlaceholder('https://example.com').fill('https://example.com');
    await page.getByRole('button', { name: /^create project$/i }).click();

    // Server redirects to /projects/:id on success.
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);

    // Visit the list and confirm the new project renders.
    await page.goto('/projects');
    await expect(page.getByText(projectName).first()).toBeVisible();
  });
});
