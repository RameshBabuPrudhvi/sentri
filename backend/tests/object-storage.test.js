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

  console.log("✅ object-storage: all checks passed");
} catch (err) {
  console.error("❌ object-storage failed:", err);
  process.exit(1);
}
