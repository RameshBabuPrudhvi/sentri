/**
 * @module tests/object-storage
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runScript(env, code) {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(res.stderr || res.stdout);
  return res.stdout.trim();
}

try {
  const localOut = runScript({}, `
    import { isS3Storage } from './src/utils/objectStorage.js';
    console.log(isS3Storage() ? 's3' : 'local');
  `);
  assert.equal(localOut, "local");

  const s3Url = runScript({
    STORAGE_BACKEND: "s3",
    S3_BUCKET: "demo-bucket",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
    S3_SECRET_ACCESS_KEY: "SECRETEXAMPLE",
  }, `
    import { signS3ArtifactUrl } from './src/utils/objectStorage.js';
    console.log(signS3ArtifactUrl('/artifacts/screenshots/test.png', 60000));
  `);
  assert.ok(s3Url.startsWith("https://demo-bucket.s3.us-east-1.amazonaws.com/screenshots/test.png?"));
  assert.ok(s3Url.includes("X-Amz-Signature="));
  // Pre-signed URL must use RFC 3986 encoding (no `+` for space) and sorted params.
  assert.ok(!s3Url.includes("+"), "query string must not contain form-encoded `+`");
  const qIdx = s3Url.indexOf("?");
  const qs = s3Url.slice(qIdx + 1).split("&").map(p => p.split("=")[0]);
  const sorted = [...qs].sort();
  assert.deepEqual(qs, sorted, "query parameters must be sorted lexicographically");

  // Regression: custom S3_ENDPOINT (R2/MinIO) must include bucket in path.
  const r2Url = runScript({
    STORAGE_BACKEND: "s3",
    S3_BUCKET: "demo-bucket",
    S3_REGION: "auto",
    S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
    S3_SECRET_ACCESS_KEY: "SECRETEXAMPLE",
  }, `
    import { signS3ArtifactUrl } from './src/utils/objectStorage.js';
    console.log(signS3ArtifactUrl('/artifacts/screenshots/test.png', 60000));
  `);
  assert.ok(
    r2Url.startsWith("https://acct.r2.cloudflarestorage.com/demo-bucket/screenshots/test.png?"),
    `custom-endpoint URL missing bucket: ${r2Url}`
  );

  // Keys with special characters must be RFC 3986 encoded per segment.
  const specialUrl = runScript({
    STORAGE_BACKEND: "s3",
    S3_BUCKET: "demo-bucket",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
    S3_SECRET_ACCESS_KEY: "SECRETEXAMPLE",
  }, `
    import { signS3ArtifactUrl } from './src/utils/objectStorage.js';
    console.log(signS3ArtifactUrl('/artifacts/screenshots/has space&q=1.png', 60000));
  `);
  assert.ok(specialUrl.includes("has%20space%26q%3D1.png"), `special chars not encoded: ${specialUrl}`);

  // writeArtifactBuffer: local dual-write + S3 upload via mock server + error path.
  const mockOut = runScript({}, `
    import http from 'node:http';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import assert from 'node:assert/strict';

    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, auth: req.headers.authorization, len: Buffer.concat(chunks).length });
        if (req.url.includes('fail')) { res.statusCode = 500; res.end('boom'); return; }
        res.statusCode = 200; res.end('ok');
      });
    });
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;
    process.env.STORAGE_BACKEND = 's3';
    process.env.S3_BUCKET = 'demo-bucket';
    process.env.S3_REGION = 'us-east-1';
    process.env.S3_ENDPOINT = 'http://127.0.0.1:' + port;
    process.env.S3_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.S3_SECRET_ACCESS_KEY = 'SECRETEXAMPLE';
    const { writeArtifactBuffer } = await import('./src/utils/objectStorage.js');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'objstore-'));
    const abs = path.join(tmp, 'screenshots', 'ok.png');
    await writeArtifactBuffer({ artifactPath: '/artifacts/screenshots/ok.png', absolutePath: abs, buffer: Buffer.from('hello'), contentType: 'image/png' });
    assert.ok(fs.existsSync(abs), 'local dual-write missing');
    assert.equal(fs.readFileSync(abs).toString(), 'hello');
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'PUT');
    assert.ok(received[0].url.startsWith('/demo-bucket/screenshots/ok.png'), 'bucket missing from PUT URL: ' + received[0].url);
    assert.ok(received[0].auth && received[0].auth.startsWith('AWS4-HMAC-SHA256 '), 'missing SigV4 auth header');

    const failAbs = path.join(tmp, 'screenshots', 'fail.png');
    let threw = null;
    try {
      await writeArtifactBuffer({ artifactPath: '/artifacts/screenshots/fail.png', absolutePath: failAbs, buffer: Buffer.from('x'), contentType: 'image/png' });
    } catch (e) { threw = e; }
    assert.ok(threw && /S3 upload failed \\(500\\)/.test(threw.message), 'expected S3 upload failure to throw');
    assert.ok(fs.existsSync(failAbs), 'local file should still be written even when S3 upload fails');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('mock-ok');
  `);
  assert.equal(mockOut, "mock-ok");

  console.log("✅ object-storage: all checks passed");
} catch (err) {
  console.error("❌ object-storage failed:", err);
  process.exit(1);
}
