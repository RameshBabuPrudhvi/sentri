import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  findGreenBaseRun,
  getRegressedFailures,
  renderGithubCheckSummary,
  conclusionForRun,
} from '../src/utils/runResultFormatters.js';
import {
  clearInstallationTokenCache,
  createPending,
  conclude,
} from '../src/integrations/githubChecks.js';
import * as runRepo from '../src/database/repositories/runRepo.js';
import * as projectRepo from '../src/database/repositories/projectRepo.js';
import { resetDb } from './helpers/test-base.js';

const { privateKey: TEST_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = TEST_PRIVATE_KEY.export({ type: 'pkcs1', format: 'pem' });

function makeFetch(calls) {
  return async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes('/access_tokens')) {
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({ token: 'inst-token', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
      };
    }
    return {
      ok: true,
      headers: { get: () => null },
      json: async () => ({ id: 123, status: opts.method === 'POST' ? 'queued' : 'completed' }),
    };
  };
}

test('payload shape creates queued check and uses cached installation token', async () => {
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = PRIVATE_KEY;
  clearInstallationTokenCache();
  const calls = [];
  await createPending('RUN-1', { repo: 'acme/app', sha: 'abc', installationId: '99' }, { fetchImpl: makeFetch(calls) });
  await conclude(123, { repo: 'acme/app', installationId: '99', conclusion: 'success', summaryMd: 'ok' }, { fetchImpl: makeFetch(calls) });
  assert.equal(calls.filter((c) => String(c.url).includes('/access_tokens')).length, 1);
  assert.equal(calls[1].body.status, 'queued');
  assert.equal(calls[1].body.head_sha, 'abc');
  assert.equal(calls[2].body.conclusion, 'success');
});

test('regressed diff includes failures that were green on the base run only', () => {
  const run = { results: [
    { testId: 'a', testName: 'A', status: 'failed' },
    { testId: 'b', testName: 'B', status: 'failed' },
  ] };
  const baseRun = { results: [
    { testId: 'a', status: 'passed' },
    { testId: 'b', status: 'failed' },
  ] };
  const diff = getRegressedFailures(run, baseRun);
  assert.equal(diff.fallback, false);
  assert.deepEqual(diff.tests.map((t) => t.testId), ['a']);
});

test('fallback path lists all failing tests when no green base run exists', () => {
  const run = { results: [
    { testId: 'a', status: 'failed' },
    { testId: 'b', status: 'passed' },
  ] };
  const diff = getRegressedFailures(run, null);
  assert.equal(diff.fallback, true);
  assert.deepEqual(diff.tests.map((t) => t.testId), ['a']);
  assert.match(renderGithubCheckSummary({ ...run, passed: 1, failed: 1, total: 2 }), /No green base run/);
});

test('findGreenBaseRun is bounded and matches repo plus base SHA', () => {
  const runs = [
    { type: 'test_run', status: 'completed', failed: 1, githubCheck: { repo: 'acme/app', sha: 'base' }, results: [] },
    { type: 'test_run', status: 'completed', failed: 0, githubCheck: { repo: 'acme/app', sha: 'base' }, results: [{ testId: 'a', status: 'passed' }] },
  ];
  assert.equal(findGreenBaseRun(runs, 'base', 'acme/app'), runs[1]);
  assert.equal(findGreenBaseRun(runs, 'other', 'acme/app'), null);
});

test('summary renders Web Vitals violations separately and conclusion fails', () => {
  // Use the real { rule, threshold, actual, testId, testName } shape produced
  // by evaluateWebVitalsBudgets in backend/src/testRunner.js. The previous
  // plain-string fixture masked a `[object Object]` rendering bug because
  // String('LCP exceeded budget') happens to return the string unchanged —
  // but production violations are always objects.
  const run = {
    passed: 1,
    failed: 1,
    total: 2,
    results: [],
    gateResult: {
      passed: false,
      violations: [
        { rule: 'minPassRate', threshold: 80, actual: 50 },
      ],
    },
    webVitalsResult: {
      passed: false,
      violations: [
        { rule: 'lcp', threshold: 2500, actual: 4200, testId: 't1', testName: 'Checkout page' },
      ],
    },
  };
  const md = renderGithubCheckSummary(run, { baseRun: { results: [] }, runUrl: 'https://sentri/runs/RUN-1' });
  assert.match(md, /Quality gate violations/);
  assert.match(md, /minPassRate: actual 50 vs threshold 80/);
  assert.match(md, /Web Vitals budget violations/);
  assert.match(md, /LCP on Checkout page: actual 4200 vs threshold 2500/);
  assert.doesNotMatch(md, /\[object Object\]/, 'violations must not render as [object Object]');
  assert.equal(conclusionForRun(run), 'failure');
});

test('Web Vitals violation without testName falls back to testId in the formatted bullet', () => {
  const run = {
    passed: 0,
    failed: 0,
    total: 1,
    results: [],
    webVitalsResult: {
      passed: false,
      violations: [
        { rule: 'cls', threshold: 0.1, actual: 0.42, testId: 't-no-name' },
      ],
    },
  };
  const md = renderGithubCheckSummary(run, { baseRun: { results: [] } });
  assert.match(md, /CLS on t-no-name: actual 0\.42 vs threshold 0\.1/);
  assert.doesNotMatch(md, /\[object Object\]/);
});

test('GitHub 5xx surfaces to caller after retries so integration hook can log and swallow', async () => {
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = PRIVATE_KEY;
  clearInstallationTokenCache();
  let attempts = 0;
  await assert.rejects(
    () => createPending('RUN-2', { repo: 'acme/app', sha: 'abc', installationId: '99' }, {
      fetchImpl: async () => {
        attempts++;
        return { ok: false, status: 502, statusText: 'Bad Gateway', headers: { get: () => null }, text: async () => 'bad' };
      },
    }),
    /GitHub API 502/,
  );
  // 3 retry attempts on the /access_tokens call; createPending never reaches
  // the check-runs POST because the token exchange itself fails.
  assert.equal(attempts, 3);
});

test('transient 5xx is retried and the call succeeds when GitHub recovers', async () => {
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = PRIVATE_KEY;
  clearInstallationTokenCache();
  let tokenCalls = 0;
  let createCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('/access_tokens')) {
      tokenCalls++;
      if (tokenCalls === 1) {
        return { ok: false, status: 503, statusText: 'Service Unavailable', headers: { get: () => null }, text: async () => 'down' };
      }
      return { ok: true, headers: { get: () => null }, json: async () => ({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() }) };
    }
    createCalls++;
    return { ok: true, headers: { get: () => null }, json: async () => ({ id: 42, status: 'queued' }) };
  };
  const result = await createPending('RUN-3', { repo: 'acme/app', sha: 'abc', installationId: '100' }, { fetchImpl });
  assert.equal(result.id, 42);
  assert.equal(tokenCalls, 2);
  assert.equal(createCalls, 1);
});

test('findByGithubDeliveryId returns the existing run so retried deliveries are idempotent', () => {
  resetDb();
  // INT-002 idempotency contract: GitHub retries non-2xx deliveries with the
  // same X-GitHub-Delivery UUID for up to 24h. The delivery ID — not the
  // commit SHA — is the correct idempotency key. Two deliveries for the
  // same SHA but different UUIDs (e.g. `pull_request.synchronize` followed
  // by `check_suite.rerequested` after a "Re-run" click) are distinct
  // events and must each produce a fresh Check Run; only retries of the
  // SAME delivery must reuse the existing checkRunId.
  const projectId = 'PRJ-IDEM';
  // FK: runs.projectId references projects(id) — seed the parent row before
  // inserting runs, otherwise SQLite raises SQLITE_CONSTRAINT_FOREIGNKEY.
  projectRepo.create({
    id: projectId,
    name: 'Idempotency Project',
    url: 'https://idem.test',
    createdAt: new Date().toISOString(),
    status: 'idle',
  });
  runRepo.create({
    id: 'RUN-IDEM-OLD',
    projectId,
    type: 'test_run',
    status: 'completed',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    githubCheck: { checkRunId: 111, deliveryId: 'delivery-old', repo: 'acme/app', sha: 'abc', installationId: '99' },
    results: [],
  });
  runRepo.create({
    id: 'RUN-IDEM-MATCH',
    projectId,
    type: 'test_run',
    status: 'running',
    startedAt: new Date().toISOString(),
    githubCheck: { checkRunId: 222, deliveryId: 'delivery-current', repo: 'acme/app', sha: 'abc', installationId: '99' },
    results: [],
  });
  const match = runRepo.findByGithubDeliveryId(projectId, 'delivery-current');
  assert.ok(match, 'expected to find the run for the current delivery');
  assert.equal(match.id, 'RUN-IDEM-MATCH');
  assert.equal(match.githubCheck.checkRunId, 222);
  // A different delivery for the same SHA must NOT match — distinct events
  // deserve fresh Check Runs.
  assert.equal(runRepo.findByGithubDeliveryId(projectId, 'delivery-new'), undefined);
  // Misses across projects / missing delivery IDs.
  assert.equal(runRepo.findByGithubDeliveryId('PRJ-OTHER', 'delivery-current'), undefined);
  assert.equal(runRepo.findByGithubDeliveryId(projectId, null), undefined);
  assert.equal(runRepo.findByGithubDeliveryId(projectId, ''), undefined);
});

test('Retry-After header is honoured when GitHub returns 429', async () => {
  process.env.GITHUB_APP_ID = '1';
  process.env.GITHUB_APP_PRIVATE_KEY = PRIVATE_KEY;
  clearInstallationTokenCache();
  let calls = 0;
  const start = Date.now();
  const fetchImpl = async (url) => {
    if (String(url).includes('/access_tokens')) {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '1' : null },
          text: async () => 'rate-limited',
        };
      }
      return { ok: true, headers: { get: () => null }, json: async () => ({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() }) };
    }
    return { ok: true, headers: { get: () => null }, json: async () => ({ id: 7 }) };
  };
  await createPending('RUN-4', { repo: 'acme/app', sha: 'abc', installationId: '101' }, { fetchImpl });
  assert.ok(Date.now() - start >= 900, 'expected to wait at least ~1s per Retry-After');
});
