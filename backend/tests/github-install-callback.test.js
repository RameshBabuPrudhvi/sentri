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
import { encryptString, decryptString } from '../src/utils/credentialEncryption.js';
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

// ─── INT-002b override: installationId encryption at rest ────────────────────
// These tests lock in the four invariants of the compliance-driven encryption
// override (see docs/changelog.md § Security and ROADMAP.md § INT-002b
// "Reversal of prior WONTFIX"). If any of them regresses, either the
// encryption is silently disabled (compliance regression) or legacy plaintext
// rows stop being readable (operational regression). Both are unacceptable.

test('encryptString / decryptString round-trip preserves the value', () => {
  const plaintext = '1234567890';
  const encrypted = encryptString(plaintext);
  assert.ok(encrypted?.startsWith('enc:v1:'), 'encryptString must emit version-prefixed ciphertext');
  assert.notEqual(encrypted, plaintext, 'ciphertext must not equal plaintext');
  assert.equal(decryptString(encrypted), plaintext);
  // Random IV means the same plaintext must produce different ciphertext each
  // call — this is the property that breaks SQL WHERE equality lookups and
  // forces the load-and-filter pattern in githubCheckSettingsRepo.
  assert.notEqual(encryptString(plaintext), encrypted, 'AES-GCM must use a fresh IV per encryption');
});

test('decryptString returns legacy plaintext unchanged (no enc:v1: prefix)', () => {
  // This is the transparent-migration contract: pre-override rows written
  // before encryption shipped must keep decrypting cleanly until they're
  // overwritten by the next upsert(). Without this branch the App-webhook
  // disables would silently no-op against legacy rows.
  assert.equal(decryptString('77'), '77');
  assert.equal(decryptString('legacy-installation-id'), 'legacy-installation-id');
  // Null / undefined / empty all return null (matches encryptString's contract).
  assert.equal(decryptString(null), null);
  assert.equal(decryptString(undefined), null);
  assert.equal(decryptString(''), null);
});

test('githubCheckSettingsRepo encrypts installationId on write and decrypts on read', () => {
  resetDb();
  seedProject();
  const now = new Date().toISOString();
  githubCheckSettingsRepo.upsert({
    projectId: 'PRJ-GH', enabled: true, installationId: '99', repo: 'acme/app',
    createdAt: now, updatedAt: now,
  });

  // Read via the repo — must come back decrypted.
  const settings = githubCheckSettingsRepo.getByProjectId('PRJ-GH');
  assert.equal(settings.installationId, '99', 'repo read must return plaintext via decryptString');

  // Read the raw column directly — must be ciphertext, never plaintext at rest.
  // This is the audit-checkbox we're paying for; if this assertion ever fails,
  // the encryption layer was silently bypassed somewhere.
  const db = getDatabase();
  const row = db.prepare('SELECT installationId FROM github_check_settings WHERE projectId = ?').get('PRJ-GH');
  assert.ok(row.installationId.startsWith('enc:v1:'), 'raw column must be encrypted at rest');
  assert.notEqual(row.installationId, '99', 'plaintext must not leak into the column');
});

test('installation-keyed lookups resolve after SQL-equality optimisation was traded away', () => {
  // Two projects on the same installation, plus a third on a different one.
  // getByInstallationId / disableByRepo / disableByInstallationId can no longer
  // use `WHERE installationId = ?` against the non-deterministic ciphertext —
  // they load and decrypt every row, then JS-filter. Lock in that the
  // load-and-filter still finds the right rows.
  resetDb();
  seedProject();
  projectRepo.create({ id: 'PRJ-GH-A', name: 'A', url: 'https://a.test', createdAt: new Date().toISOString(), status: 'idle' });
  projectRepo.create({ id: 'PRJ-GH-B', name: 'B', url: 'https://b.test', createdAt: new Date().toISOString(), status: 'idle' });
  projectRepo.create({ id: 'PRJ-GH-C', name: 'C', url: 'https://c.test', createdAt: new Date().toISOString(), status: 'idle' });
  const now = new Date().toISOString();
  githubCheckSettingsRepo.upsert({ projectId: 'PRJ-GH-A', enabled: true, installationId: '500', repo: 'acme/a', createdAt: now, updatedAt: now });
  githubCheckSettingsRepo.upsert({ projectId: 'PRJ-GH-B', enabled: true, installationId: '500', repo: 'acme/b', createdAt: now, updatedAt: now });
  githubCheckSettingsRepo.upsert({ projectId: 'PRJ-GH-C', enabled: true, installationId: '600', repo: 'acme/c', createdAt: now, updatedAt: now });

  const matches = githubCheckSettingsRepo.getByInstallationId('500');
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((r) => r.projectId).sort(), ['PRJ-GH-A', 'PRJ-GH-B']);

  const narrowed = githubCheckSettingsRepo.disableByRepo('500', 'acme/a');
  assert.deepEqual(narrowed, ['PRJ-GH-A']);
  assert.equal(githubCheckSettingsRepo.getByProjectId('PRJ-GH-A').enabled, false);
  assert.equal(githubCheckSettingsRepo.getByProjectId('PRJ-GH-B').enabled, true, 'sibling project on same installation must remain enabled');

  const disabled = githubCheckSettingsRepo.disableByInstallationId('500');
  assert.deepEqual(disabled, ['PRJ-GH-B']);
  assert.equal(githubCheckSettingsRepo.getByProjectId('PRJ-GH-B').enabled, false);
  assert.equal(githubCheckSettingsRepo.getByProjectId('PRJ-GH-C').enabled, true, 'unrelated installation must not be disabled');
});

test('legacy plaintext rows continue to read correctly and re-encrypt on next write', () => {
  // Simulate a pre-override row by writing the plaintext column directly,
  // bypassing the repo's upsert(). The next read via the repo must still
  // surface the right installationId — this protects existing deployments
  // from a hard cutover on upgrade.
  resetDb();
  seedProject();
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO github_check_settings (projectId, enabled, installationId, repo, createdAt, updatedAt)
    VALUES (?, 1, ?, ?, ?, ?)`).run('PRJ-GH', 'legacy-77', 'acme/legacy', now, now);

  const settings = githubCheckSettingsRepo.getByProjectId('PRJ-GH');
  assert.equal(settings.installationId, 'legacy-77', 'legacy plaintext must pass through decryptString untouched');
  assert.equal(settings.enabled, true);

  // Re-upsert — repo must now encrypt it, locking in the "rows re-encrypt
  // naturally on next write" contract from the module doc.
  githubCheckSettingsRepo.upsert({
    projectId: 'PRJ-GH', enabled: true, installationId: 'legacy-77', repo: 'acme/legacy',
    createdAt: now, updatedAt: new Date().toISOString(),
  });
  const raw = db.prepare('SELECT installationId FROM github_check_settings WHERE projectId = ?').get('PRJ-GH');
  assert.ok(raw.installationId.startsWith('enc:v1:'), 'upsert must re-encrypt previously-plaintext rows');
  assert.equal(githubCheckSettingsRepo.getByProjectId('PRJ-GH').installationId, 'legacy-77');
});
