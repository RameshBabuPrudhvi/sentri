import { test, expect } from '../utils/playwright.mjs';
import * as userRepo from '../../../backend/src/database/repositories/userRepo.js';
import * as verificationTokenRepo from '../../../backend/src/database/repositories/verificationTokenRepo.js';
import { loginWithRetry, registerUser, safeJson } from '../utils/auth.mjs';
import { SessionClient } from '../utils/session.mjs';

test.describe('Sentri full functional API flows', () => {
  test('verify account, login, project+test CRUD happy path', async ({ request }) => {
    const api = new SessionClient(request);
    const { email, password } = await registerUser(request);

    const user = userRepo.getByEmail(email);
    expect(user).toBeTruthy();
    const tokenRow = verificationTokenRepo.getUnusedByUserId(user.id);
    expect(tokenRow?.token).toBeTruthy();

    const verifyRes = await api.call('get', `/api/v1/auth/verify?token=${encodeURIComponent(tokenRow.token)}`);
    expect(verifyRes.status()).toBe(200);

    const loginRes = await loginWithRetry(request, email, password);
    if (loginRes.status() === 429) test.skip(true, 'Rate-limited in shared local environment');
    expect(loginRes.status()).toBe(200);

    const meRes = await api.call('get', '/api/v1/auth/me');
    expect(meRes.status()).toBe(200);
    const me = await safeJson(meRes);
    expect(me.email).toBe(email);

    const projectRes = await api.call('post', '/api/v1/projects', {
      data: { name: 'E2E Functional Project', url: 'https://example.com' },
    });
    expect(projectRes.status()).toBe(201);
    const project = await safeJson(projectRes);
    expect(project.id).toMatch(/^PRJ-/);

    const createTestRes = await api.call('post', `/api/v1/projects/${project.id}/tests`, {
      data: {
        name: 'E2E Manual Test',
        steps: ['Open homepage', 'Assert title'],
        priority: 'medium',
      },
    });
    expect(createTestRes.status()).toBe(201);
    const createdTest = await safeJson(createTestRes);
    expect(createdTest.id).toMatch(/^TC-/);

    const listTestsRes = await api.call('get', `/api/v1/projects/${project.id}/tests`);
    expect(listTestsRes.status()).toBe(200);
    const testsList = await safeJson(listTestsRes);
    expect(Array.isArray(testsList)).toBeTruthy();
    expect(testsList.some((t) => t.id === createdTest.id)).toBeTruthy();

    const approveRes = await api.call('patch', `/api/v1/projects/${project.id}/tests/${createdTest.id}/approve`, {
      data: {},
    });
    expect(approveRes.status()).toBe(200);

    const deleteTestRes = await api.call('delete', `/api/v1/projects/${project.id}/tests/${createdTest.id}`);
    expect(deleteTestRes.status()).toBe(200);

    const deleteProjectRes = await api.call('delete', `/api/v1/projects/${project.id}`);
    expect(deleteProjectRes.status()).toBe(200);
  });

  test('negative validations for project/test inputs', async ({ request }) => {
    const api = new SessionClient(request);
    const { email, password } = await registerUser(request);
    const user = userRepo.getByEmail(email);
    const tokenRow = verificationTokenRepo.getUnusedByUserId(user.id);

    await api.call('get', `/api/v1/auth/verify?token=${encodeURIComponent(tokenRow.token)}`);
    const loginRes = await loginWithRetry(request, email, password);
    if (loginRes.status() === 429) test.skip(true, 'Rate-limited in shared local environment');

    const badProjectRes = await api.call('post', '/api/v1/projects', {
      data: { name: 'Bad URL Project', url: 'ftp://invalid.local' },
    });
    expect(badProjectRes.status()).toBe(400);

    const goodProjectRes = await api.call('post', '/api/v1/projects', {
      data: { name: 'Validation Host', url: 'https://example.com' },
    });
    expect(goodProjectRes.status()).toBe(201);
    const project = await safeJson(goodProjectRes);

    const badTestRes = await api.call('post', `/api/v1/projects/${project.id}/tests`, {
      data: { name: '', steps: 'not-an-array' },
    });
    expect(badTestRes.status()).toBe(400);
  });

  test('session security: logout revokes access and missing CSRF blocks mutation', async ({ request }) => {
    const api = new SessionClient(request);
    const { email, password } = await registerUser(request);
    const user = userRepo.getByEmail(email);
    const tokenRow = verificationTokenRepo.getUnusedByUserId(user.id);

    await api.call('get', `/api/v1/auth/verify?token=${encodeURIComponent(tokenRow.token)}`);
    const loginRes = await loginWithRetry(request, email, password);
    if (loginRes.status() === 429) test.skip(true, 'Rate-limited in shared local environment');
    expect(loginRes.status()).toBe(200);

    // Control: mutation works with SessionClient-managed CSRF.
    const okProject = await api.call('post', '/api/v1/projects', {
      data: { name: 'CSRF Control Project', url: 'https://example.com' },
    });
    expect(okProject.status()).toBe(201);

    // Separate raw request context without CSRF header should be blocked.
    const missingCsrfRes = await request.post('/api/v1/projects', {
      data: { name: 'Should Fail CSRF', url: 'https://example.com' },
    });
    expect([401, 403]).toContain(missingCsrfRes.status());

    const logoutRes = await api.call('post', '/api/v1/auth/logout', { data: {} });
    expect(logoutRes.status()).toBe(200);

    const dashboardAfterLogout = await api.call('get', '/api/v1/dashboard');
    expect(dashboardAfterLogout.status()).toBe(401);
  });
});
