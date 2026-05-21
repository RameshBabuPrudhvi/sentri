import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const runner = t.createTestRunner();

async function main() {
  const server = t.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await runner.test("GET /api/v1/health returns JSON shape", async () => {
      const res = await fetch(`${base}/api/v1/health`);
      assert.ok([200, 503].includes(res.status), `unexpected status: ${res.status}`);
      const body = await res.json();
      assert.equal(typeof body.ok, "boolean");
      assert.equal(typeof body.checks, "object");
      assert.equal(typeof body.checks.database, "boolean");
      assert.equal(typeof body.checks.redis, "boolean");
    });

    await runner.test("GET /api/v1/health is 503 when Redis is unavailable", async () => {
      const env = t.setupEnv({ REDIS_URL: "" });
      try {
        const res = await fetch(`${base}/api/v1/health`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.checks.redis, false);
      } finally {
        env.restore();
      }
    });
  } finally {
    await new Promise((r) => server.close(r));
  }

  runner.summary("health-routes");
}

await main();
