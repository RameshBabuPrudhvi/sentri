import { test, expect } from '../utils/playwright.mjs';
import * as userRepo from '../../../backend/src/database/repositories/userRepo.js';
import * as verificationTokenRepo from '../../../backend/src/database/repositories/verificationTokenRepo.js';
import { loginWithRetry, registerUser, safeJson } from '../utils/auth.mjs';
import { SessionClient } from '../utils/session.mjs';

async function bootstrapQaWorkspace(request) {
  const api = new SessionClient(request);
  const { email, password } = await registerUser(request);
  const user = userRepo.getByEmail(email);
  const tokenRow = verificationTokenRepo.getUnusedByUserId(user.id);

  await api.call('get', `/api/v1/auth/verify?token=${encodeURIComponent(tokenRow.token)}`);
  const loginRes = await loginWithRetry(request, email, password);
  if (loginRes.status() === 429) test.skip(true, 'Rate-limited in shared local environment');
  expect(loginRes.status()).toBe(200);

  const projectRes = await api.call('post', '/api/v1/projects', {
    data: { name: 'Functional Areas Project', url: 'https://example.com' },
  });
  expect(projectRes.status()).toBe(201);
  const project = await safeJson(projectRes);

  return { api, project };
}

test.describe('Sentri functional area coverage (API E2E)', () => {
  test('project tests workflow: create, approve/reject/restore, export, run', async ({ request }) => {
    const { api, project } = await bootstrapQaWorkspace(request);

    const t1Res = await api.call('post', `/api/v1/projects/${project.id}/tests`, {
      data: { name: 'Approve Me', steps: ['Open app', 'Verify home'] },
    });
    expect(t1Res.status()).toBe(201);
    const t1 = await safeJson(t1Res);

    const t2Res = await api.call('post', `/api/v1/projects/${project.id}/tests`, {
      data: { name: 'Reject Me', steps: ['Open app', 'Click sign in'] },
    });
    expect(t2Res.status()).toBe(201);
    const t2 = await safeJson(t2Res);

    expect((await api.call('patch', `/api/v1/projects/${project.id}/tests/${t1.id}/approve`, { data: {} })).status()).toBe(200);
    expect((await api.call('patch', `/api/v1/projects/${project.id}/tests/${t2.id}/reject`, { data: {} })).status()).toBe(200);
    expect((await api.call('patch', `/api/v1/projects/${project.id}/tests/${t2.id}/restore`, { data: {} })).status()).toBe(200);

    const zephyrRes = await api.call('get', `/api/v1/projects/${project.id}/tests/export/zephyr`);
    expect(zephyrRes.status()).toBe(200);
    expect((await zephyrRes.text()).toLowerCase()).toContain('"objective"');

    const testrailRes = await api.call('get', `/api/v1/projects/${project.id}/tests/export/testrail`);
    expect(testrailRes.status()).toBe(200);
    expect((await testrailRes.text()).toLowerCase()).toContain('title');

    const traceRes = await api.call('get', `/api/v1/projects/${project.id}/tests/traceability`);
    expect(traceRes.status()).toBe(200);

    // Run all approved tests (asynchronous). We only assert orchestration response.
    const runRes = await api.call('post', `/api/v1/projects/${project.id}/run`, { data: {} });
    expect([200, 202]).toContain(runRes.status());
    const runPayload = await safeJson(runRes);
    expect(String(runPayload.runId || '')).toMatch(/^RUN-/);
  });

  test('crawl + generate + recorder + ai-fix/chat endpoint contracts', async ({ request }) => {
    const { api, project } = await bootstrapQaWorkspace(request);

    const crawlRes = await api.call('post', `/api/v1/projects/${project.id}/crawl`, { data: {} });
    expect([200, 202]).toContain(crawlRes.status());

    const generateRes = await api.call('post', `/api/v1/projects/${project.id}/tests/generate`, {
      data: { name: 'AI Generated', description: 'Verify login flow' },
    });
    // 202 when provider configured, 503 when not configured.
    expect([202, 503]).toContain(generateRes.status());

    const recordStartRes = await api.call('post', `/api/v1/projects/${project.id}/record`, {
      data: { startUrl: 'https://example.com' },
    });
    // 202 when browser runtime is available, 500 in constrained environments.
    expect([202, 500]).toContain(recordStartRes.status());

    if (recordStartRes.status() === 202) {
      const payload = await safeJson(recordStartRes);
      const sessionId = payload.sessionId;
      const statusRes = await api.call('get', `/api/v1/projects/${project.id}/record/${sessionId}`);
      expect(statusRes.status()).toBe(200);

      const discardRes = await api.call('post', `/api/v1/projects/${project.id}/record/${sessionId}/stop`, {
        data: { discard: true },
      });
      expect(discardRes.status()).toBe(200);
    } else {
      const missingSessionStatus = await api.call('get', `/api/v1/projects/${project.id}/record/REC-missing`);
      expect(missingSessionStatus.status()).toBe(404);
    }

    const manualTestRes = await api.call('post', `/api/v1/projects/${project.id}/tests`, {
      data: {
        name: 'AI Fix Candidate',
        steps: ['Open page'],
        playwrightCode: "test('AI Fix Candidate', async ({ page }) => { await page.goto('https://example.com'); });",
      },
    });
    expect(manualTestRes.status()).toBe(201);
    const manualTest = await safeJson(manualTestRes);

    const applyFixRes = await api.call('post', `/api/v1/tests/${manualTest.id}/apply-fix`, {
      data: { code: "test('AI Fix Candidate', async ({ page }) => { await page.goto('https://example.com'); await page.waitForLoadState('domcontentloaded'); });" },
    });
    expect(applyFixRes.status()).toBe(200);

    const chatRes = await api.call('post', '/api/v1/chat', {
      data: { messages: [{ role: 'user', content: 'Summarize this workspace status.' }] },
    });
    // Streaming endpoint: 200 on success, 5xx when provider unavailable/busy.
    expect([200, 500, 503]).toContain(chatRes.status());
  });
});
