/**
 * @module tests/trace-viewer-static
 * @description Smoke tests for /trace-viewer static serving.
 */

import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { app } from "../src/middleware/appSetup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewerDir = path.join(__dirname, "..", "public", "trace-viewer");
const indexHtml = path.join(viewerDir, "index.html");
const backupHtml = path.join(viewerDir, "index.html.bak-test");

async function main() {
  const hadIndex = fs.existsSync(indexHtml);
  if (!hadIndex) {
    fs.mkdirSync(viewerDir, { recursive: true });
    fs.writeFileSync(indexHtml, "<html><body>trace viewer test</body></html>");
  }

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    let res = await fetch(`${base}/trace-viewer/index.html`);
    assert.equal(res.status, 200, "trace viewer index should serve when bundle is present");
    const body = await res.text();
    assert.ok(body.length > 0, "trace viewer index response should be non-empty");

    fs.renameSync(indexHtml, backupHtml);
    res = await fetch(`${base}/trace-viewer/index.html`);
    assert.equal(res.status, 404, "trace viewer index should 404 when bundle is missing");

    fs.renameSync(backupHtml, indexHtml);

    console.log("✅ trace-viewer-static: all checks passed");
  } finally {
    try {
      if (fs.existsSync(backupHtml) && !fs.existsSync(indexHtml)) {
        fs.renameSync(backupHtml, indexHtml);
      }
      if (!hadIndex && fs.existsSync(indexHtml)) {
        fs.unlinkSync(indexHtml);
      }
    } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ trace-viewer-static failed:", err);
  process.exit(1);
});
