import { test, expect } from '../utils/playwright.mjs';
import { registerUser, safeJson } from '../utils/auth.mjs';

test.describe('Sentri API auth + core health', () => {
  test('health endpoint responds', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.ok()).toBeTruthy();
  });

  test('register creates user and login is blocked until verification', async ({ request }) => {
    const { email, password } = await registerUser(request);

    const loginResponse = await request.post('/api/v1/auth/login', {
      data: { email, password },
    });

    expect(loginResponse.status()).toBe(403);
    const payload = await safeJson(loginResponse);
    expect(String(payload.error || '').toLowerCase()).toContain('verify');
  });

  test('login negative path with bad password', async ({ request }) => {
    const { email } = await registerUser(request);

    const loginResponse = await request.post('/api/v1/auth/login', {
      data: { email, password: 'WrongPass123!' },
    });

    expect([400, 401]).toContain(loginResponse.status());
    const payload = await safeJson(loginResponse);
    expect(String(payload.error || '').length).toBeGreaterThan(0);
  });
});
