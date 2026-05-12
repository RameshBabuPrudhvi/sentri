import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { resetDb } from './helpers/test-base.js';
import { getDatabase } from '../src/database/sqlite.js';
import * as projectRepo from '../src/database/repositories/projectRepo.js';
import * as workspaceRepo from '../src/database/repositories/workspaceRepo.js';
import * as githubCheckSettingsRepo from '../src/database/repositories/githubCheckSettingsRepo.js';
import * as activityRepo from '../src/database/repositories/activityRepo.js';
import { signJwt, getJwtSecret } from '../src/middleware/authenticate.js';
import {
  signInstallState,
  verifyInstallState,
  clearInstallStateCache,
  clearInstallationTokenCache,
} from '../src/integrations/githubChecks.js';
import githubRouter from '../src/routes/integrations/github.js';

const { privateKey: TEST_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = TEST_PRIVATE_KEY.export({ type: 'pkcs1', format: 'pem' });

function seedProject() {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, name, email, passwordHash, role, createdAt, updatedAt, emailVerified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('USR-GH', 'GitHub Admin', 'gh-admin@example.com', 'x', 'user', now, now, 1);
  const workspace = workspaceRepo.create({ name: 'GitHub Workspace', slug: `github-${Date.now()}`, ownerId: 'USR-GH' });
  projectRepo.create({ id: 'PRJ-GH', name: 'GitHub Project', url: 'https://example.test', createdAt: now, status: 'idle', workspaceId: workspace.id });
  const token = signJwt({ sub: 'USR-GH', email: 'gh-admin@example.com', name: 'GitHub Admin', workspaceId: workspace.id }, getJwtSecret());
  return { workspace, token };
}

async function startGithubApi() {
  const app = express();
  app.use(express.json());
  app.post('/app/installations/:id/access_tokens', (req, res) => {
    res.json({ token: `token-${req.params.id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  });
  app.get('/installation/repositories', (_req, res) => {
    res.json({ repositories: [{ full_name: 'acme/app' }] });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function startSentriRouter() {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/v1/integrations/github', githubRouter);
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, json: await res.json().catch(() => ({})) };
}

function githubSignature(body) {
  return `sha256=${crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}`;
}

test('state JWT validates once, rejects tampering, expiry, and replay', async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-for-github-install-state';
  clearInstallStateCache();
  const state = await signInstallState('PRJ-GH');
  const verified = await verifyInstallState(state);
  assert.equal(verified?.projectId, 'PRJ-GH');
  assert.equal(verified?.actorId, null);
  assert.equal(verified?.actorName, null);
  assert.equal(typeof verified?.nonce, 'string');
  assert.equal(await verifyInstallState(state), null, 'state token must be one-shot');

  const tampered = `${state.slice(0, -1)}x`;
  assert.equal(await verifyInstallState(tampered), null);

  const expired = await signInstallState('PRJ-GH', { ttlSec: -1 });
  assert.equal(await verifyInstallState(expired), null);
});

test('install callback upserts enabled GitHub settings from selected repositories', async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-for-github-install-state';
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = PRIVATE_KEY;
  clearInstallStateCache();
  clearInstallationTokenCache();
  resetDb();
  const github = await startGithubApi();
  process.env.GITHUB_API_BASE = github.url;
  const { default: freshRouter } = await import(`../src/routes/integrations/github.js?callback=${Date.now()}`);
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/v1/integrations/github', freshRouter);
  const sentri = app.listen(0);
  const base = `http://127.0.0.1:${sentri.address().port}`;
  try {
    seedProject();
    // Callback is authenticated by the signed state JWT, NOT by the user
    // cookie/Bearer (browsers don't send SameSite=Strict cookies on the
    // cross-site redirect back from github.com — see route comment).
    const state = await signInstallState('PRJ-GH', {
      actor: { userId: 'USR-GH', userName: 'GitHub Admin' },
    });
    const out = await request(base, `/api/v1/integrations/github/install/callback?installation_id=99&setup_action=install&state=${encodeURIComponent(state)}`, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(out.res.status, 200, out.json.error);
    const settings = githubCheckSettingsRepo.getByProjectId('PRJ-GH');
    assert.equal(settings.enabled, true);
    assert.equal(settings.installationId, '99');
    assert.equal(settings.repo, 'acme/app');
  } finally {
    await new Promise((resolve) => sentri.close(resolve));
    await new Promise((resolve) => github.server.close(resolve));
    delete process.env.GITHUB_API_BASE;
  }
});

test('App webhook disables installation rows, narrows repository removals, and rejects invalid HMAC', async () => {
  process.env.GITHUB_WEBHOOK_SECRET = 'github-webhook-secret';
  resetDb();
  seedProject();
  projectRepo.create({ id: 'PRJ-GH-2', name: 'Other Repo', url: 'https://other.test', createdAt: new Date().toISOString(), status: 'idle' });
  githubCheckSettingsRepo.upsert({ projectId: 'PRJ-GH', enabled: true, installationId: '77', repo: 'acme/app', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  githubCheckSettingsRepo.upsert({ projectId: 'PRJ-GH-2', enabled: true, installationId: '77', repo: 'acme/other', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const sentri = startSentriRouter();
  try {
    let body = JSON.stringify({ action: 'removed', installation: { id: 77 }, repositories_removed: [{ full_name: 'acme/app' }] });
    let out = await request(sentri.base, '/api/v1/integrations/github/app-webhook', {
      method: 'POST',
      body: JSON.parse(body),
      headers: { 'X-GitHub-Event': 'installation_repositories', 'X-Hub-Signature-256': githubSignature(body) },
    });
    assert.equal(out.res.status, 200, out.json.error);
    assert.equal(githubCheckSettingsRepo.getByProjectId('PRJ-GH').enabled, false);
    assert.equal(githubCheckSettingsRepo.getByProjectId('PRJ-GH-2').enabled, true);

    body = JSON.stringify({ action: 'deleted', installation: { id: 77 } });
    out = await request(sentri.base, '/api/v1/integrations/github/app-webhook', {
      method: 'POST',
      body: JSON.parse(body),
      headers: { 'X-GitHub-Event': 'installation', 'X-Hub-Signature-256': githubSignature(body) },
    });
    assert.equal(out.res.status, 200, out.json.error);
    assert.equal(githubCheckSettingsRepo.getByProjectId('PRJ-GH-2').enabled, false);
    assert.ok(activityRepo.getFiltered({ type: 'integration.github.disabled' }).length >= 2);

    out = await request(sentri.base, '/api/v1/integrations/github/app-webhook', {
      method: 'POST',
      body: { action: 'deleted', installation: { id: 77 } },
      headers: { 'X-GitHub-Event': 'installation', 'X-Hub-Signature-256': 'sha256=bad' },
    });
    assert.equal(out.res.status, 401);
  } finally {
    await new Promise((resolve) => sentri.server.close(resolve));
  }
});
