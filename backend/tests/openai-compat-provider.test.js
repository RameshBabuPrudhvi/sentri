import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isRateLimitError, isTransientServerError } from '../src/aiProvider.js';
import { validateUrl } from '../src/utils/ssrfGuard.js';

// ── Error classification (shared retry/circuit-breaker semantics) ────────────

test('classifies auth errors as non-rate-limit/non-5xx', () => {
  const err = new Error('Unauthorized');
  err.status = 401;
  assert.equal(isRateLimitError(err), false);
  assert.equal(isTransientServerError(err), false);
});

test('classifies rate limits', () => {
  const err = new Error('Too many requests');
  err.status = 429;
  assert.equal(isRateLimitError(err), true);
});

test('classifies 5xx as transient', () => {
  const err = new Error('Service unavailable');
  err.status = 503;
  assert.equal(isTransientServerError(err), true);
});

// ── SSRF rejection at config time (NEXT.md AI-001 acceptance criteria) ───────

test('SSRF guard rejects loopback baseUrl', async () => {
  const err = await validateUrl('http://127.0.0.1:8000/v1');
  assert.ok(err, 'expected loopback URL to be rejected');
  assert.match(err, /private|reserved/i);
});

test('SSRF guard rejects private RFC1918 baseUrl', async () => {
  const err = await validateUrl('http://10.0.0.5/v1');
  assert.ok(err, 'expected RFC1918 URL to be rejected');
});

test('SSRF guard rejects link-local metadata baseUrl', async () => {
  const err = await validateUrl('http://169.254.169.254/latest/meta-data/');
  assert.ok(err, 'expected link-local URL to be rejected');
});

test('SSRF guard rejects non-http(s) protocols', async () => {
  const err = await validateUrl('file:///etc/passwd');
  assert.ok(err);
  assert.match(err, /http or https/i);
});

test('SSRF guard rejects localhost hostname', async () => {
  const err = await validateUrl('http://localhost:8000/v1');
  assert.ok(err);
});

// ── Compat slot detection (provider id shape) ────────────────────────────────

test('compat provider id shape: starts with "compat:" and has a slot id', () => {
  // Mirrors isCompatProvider() in aiProvider.js / apiKeyRepo.js.
  const isCompat = (p) => typeof p === 'string' && p.startsWith('compat:') && p.length > 'compat:'.length;
  assert.equal(isCompat('compat:deepseek'), true);
  assert.equal(isCompat('compat:groq'), true);
  assert.equal(isCompat('compat:'), false);
  assert.equal(isCompat('openai'), false);
  assert.equal(isCompat(null), false);
});

// ── ALLOW_PRIVATE_URLS env bypass ────────────────────────────────────────────
// Operator escape hatch for self-hosted / on-prem OpenAI-compatible endpoints
// (e.g. local LiteLLM, internal vLLM). When the flag is unset, loopback URLs
// MUST be rejected. When set to "true", validateUrl() returns null early.

test('SSRF guard rejects loopback when ALLOW_PRIVATE_URLS is unset', async () => {
  const prev = process.env.ALLOW_PRIVATE_URLS;
  delete process.env.ALLOW_PRIVATE_URLS;
  try {
    const err = await validateUrl('http://127.0.0.1:8000/v1');
    assert.ok(err, 'expected loopback URL to be rejected without the flag');
  } finally {
    if (prev !== undefined) process.env.ALLOW_PRIVATE_URLS = prev;
  }
});

test('SSRF guard still rejects loopback when ALLOW_PRIVATE_URLS=true (bypass is scoped to compat saves, not the shared validateUrl)', async () => {
  // The ALLOW_PRIVATE_URLS bypass is intentionally NOT applied inside
  // validateUrl() — that would also exempt trigger callback URLs, preview
  // URLs (Playwright-navigated), and webhook URLs from SSRF protection.
  // The bypass is applied locally in routes/settings.js for compat baseUrl
  // saves only.  See routes/settings.js for the scoped check.
  const prev = process.env.ALLOW_PRIVATE_URLS;
  process.env.ALLOW_PRIVATE_URLS = 'true';
  try {
    assert.ok(await validateUrl('http://127.0.0.1:8000/v1'), 'shared validateUrl must still reject loopback');
    assert.ok(await validateUrl('http://10.0.0.5/v1'), 'shared validateUrl must still reject RFC1918');
    assert.ok(await validateUrl('http://localhost:8000/v1'), 'shared validateUrl must still reject localhost');
  } finally {
    if (prev === undefined) delete process.env.ALLOW_PRIVATE_URLS;
    else process.env.ALLOW_PRIVATE_URLS = prev;
  }
});

// ── Mock-SDK integration: baseURL routing + circuit-breaker independence ─────
// We can't easily mock `new OpenAI(...)` from inside aiProvider.js (it's
// imported at module-init time), so we stand up a real loopback HTTP server
// that speaks the OpenAI chat-completions wire format and route compat slots
// to it. ALLOW_PRIVATE_URLS=true lets the loopback baseURL pass save-time
// validation. Each request records which slot called it (via Authorization
// header) so we can prove (a) baseURL is honored and (b) per-slot accounting
// is independent.

test('compat slots: baseURL is honored and circuit breakers are per-slot', async (t) => {
  process.env.ALLOW_PRIVATE_URLS = 'true';
  // Speed up retries so the test doesn't burn 30s of backoff.
  process.env.LLM_MAX_RETRIES = '0';
  process.env.LLM_BASE_DELAY_MS = '1';
  // Avoid touching the real DB; aiProvider tolerates missing DB via try/catch.
  process.env.DB_PATH = ':memory:';

  /** @type {{slot: string, ok: boolean}[]} */
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      const slot = auth.includes('key-a') ? 'a' : auth.includes('key-b') ? 'b' : '?';
      const fail = req.url.includes('/fail');
      calls.push({ slot, ok: !fail });
      if (fail) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate_limit', type: 'rate_limit_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: `ok-from-${slot}` } }],
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => new Promise((r) => server.close(r)));

  // Lazy-import so env vars are set before the module reads them.
  const apiKeyRepo = await import('../src/database/repositories/apiKeyRepo.js');
  const ai = await import('../src/aiProvider.js');

  // (a) baseURL routing — slot A points at /ok, slot B points at /fail.
  apiKeyRepo.setCompatSlot('a', {
    baseUrl: `http://127.0.0.1:${port}/ok`,
    model: 'test-model',
    // Synthetic test fixture — Authorization header is matched on "key-a"
    // below. Avoid an "sk-" prefix so gitleaks doesn't flag it as a real key.
    apiKey: 'test-fixture-key-a', // gitleaks:allow
    displayName: 'A',
  });
  apiKeyRepo.setCompatSlot('b', {
    baseUrl: `http://127.0.0.1:${port}/fail`,
    model: 'test-model',
    apiKey: 'test-fixture-key-b', // gitleaks:allow
    displayName: 'B',
  });

  ai.setActiveProvider('compat:a');
  const out = await ai.generateText('hello', { responseFormat: 'text' });
  assert.equal(out, 'ok-from-a', 'compat:a baseURL must route to slot A endpoint');
  assert.ok(calls.some((c) => c.slot === 'a' && c.ok), 'slot A should have been called');
  assert.ok(!calls.some((c) => c.slot === 'b'), 'slot B must not be called when compat:a is active');

  // (b) Circuit-breaker independence — failing compat:b must not disable compat:a.
  // Disable cross-provider fallback by clearing other cloud keys for the duration.
  const savedKeys = {};
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'DEMO_GOOGLE_API_KEY']) {
    savedKeys[k] = process.env[k];
    delete process.env[k];
  }
  try {
    // Temporarily remove compat:a from the slot list so the fallback
    // candidate scan can't pick it up — we want compat:b to surface its
    // own rate-limit error rather than silently falling back to compat:a.
    apiKeyRepo.deleteCompatSlot('a');
    ai.setActiveProvider('compat:b');
    await assert.rejects(
      ai.generateText('hello', { responseFormat: 'text' }),
      /rate.?limit|429/i,
      'compat:b should fail with a rate-limit error',
    );
    // Restore compat:a and verify it remains usable after compat:b's breaker tripped.
    apiKeyRepo.setCompatSlot('a', {
      baseUrl: `http://127.0.0.1:${port}/ok`,
      model: 'test-model',
      apiKey: 'test-fixture-key-a',
      displayName: 'A',
    });
    ai.setActiveProvider('compat:a');
    const out2 = await ai.generateText('hello again', { responseFormat: 'text' });
    assert.equal(out2, 'ok-from-a', 'compat:a must remain usable after compat:b trips its breaker');
    assert.equal(ai.isProviderDegraded(), false, 'compat:a should not be degraded by compat:b');
  } finally {
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v !== undefined) process.env[k] = v;
    }
    apiKeyRepo.deleteCompatSlot('a');
    apiKeyRepo.deleteCompatSlot('b');
    ai.setActiveProvider(null);
    delete process.env.ALLOW_PRIVATE_URLS;
  }
});

// ── DNS-rebinding mitigation: per-call SSRF re-validation ────────────────────
// The OpenAI SDK is constructed with a `fetch` wrapper that re-runs
// validateUrl() before every outbound call (createSsrfGuardedFetch in
// aiProvider.js). A baseUrl that passed validation at config-save time but
// later resolves to a private/loopback address must be rejected at call time
// rather than reaching the upstream. We don't have a real DNS-rebind primitive
// in tests, so we install the slot with ALLOW_PRIVATE_URLS=true (lets a
// loopback baseUrl save), then call WITHOUT the bypass — the per-call guard
// should reject it.

test('compat slot: per-call SSRF guard rejects loopback baseUrl after save (DNS-rebinding mitigation)', async (t) => {
  process.env.LLM_MAX_RETRIES = '0';
  process.env.LLM_BASE_DELAY_MS = '1';
  process.env.DB_PATH = ':memory:';

  // Save under the bypass so the loopback URL passes validateUrl().
  process.env.ALLOW_PRIVATE_URLS = 'true';
  const apiKeyRepo = await import('../src/database/repositories/apiKeyRepo.js');
  const ai = await import('../src/aiProvider.js');
  apiKeyRepo.setCompatSlot('rebind', {
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'test-model',
    apiKey: 'test-fixture-key-rebind',
    displayName: 'rebind',
  });
  // Drop the bypass — the per-call guard must now reject the loopback URL
  // even though the saved config is unchanged.
  delete process.env.ALLOW_PRIVATE_URLS;

  // Disable cloud fallbacks so the call fails at the compat slot, not at a
  // sibling provider that happens to be configured via env vars.
  const savedKeys = {};
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'DEMO_GOOGLE_API_KEY']) {
    savedKeys[k] = process.env[k];
    delete process.env[k];
  }

  t.after(() => {
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v !== undefined) process.env[k] = v;
    }
    apiKeyRepo.deleteCompatSlot('rebind');
    ai.setActiveProvider(null);
  });

  ai.setActiveProvider('compat:rebind');
  // The OpenAI SDK wraps fetch errors as APIConnectionError("Connection error.")
  // and preserves the original Error in `err.cause`, so we walk the cause chain
  // to find our SSRF rejection rather than matching only the top-level message.
  await assert.rejects(
    ai.generateText('hello', { responseFormat: 'text' }),
    (err) => {
      for (let e = err; e; e = e.cause) {
        if (/SSRF guard rejected|private|reserved/i.test(e.message || '')) return true;
      }
      throw new Error(`per-call SSRF guard did not block loopback baseUrl; got: ${err?.message} cause=${err?.cause?.message}`);
    },
    'per-call SSRF guard must block loopback baseUrl at request time',
  );
});
