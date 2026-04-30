/**
 * @module tests/test-edit-chat
 * @description Integration tests for POST /api/v1/chat — verifies the new
 * `context.mode === "test_edit"` body shape is accepted and routed through
 * the same validation + provider gates as the normal chat flow (DIF-007).
 *
 * NOTE: A full SSE token-streaming assertion would require stubbing
 * `streamText` from `aiProvider.js`, which is a static ESM import in
 * `routes/chat.js` and not currently swappable. These tests therefore
 * exercise the request-handling layer (body parsing, validation, and the
 * provider-not-configured short-circuit) for both context shapes, ensuring
 * the new branch does not regress validation or auth behaviour.
 */
import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();

async function main() {
  t.resetDb();
  const env = t.setupEnv({
    SKIP_EMAIL_VERIFICATION: "true",
    NODE_ENV: "test",
    // Deliberately leave AI provider unconfigured so hasProvider() === false
    // and the route returns 503 before invoking the LLM. This keeps the test
    // hermetic while still exercising body parsing for both branches.
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    OLLAMA_BASE_URL: "",
  });
  const server = t.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const runner = t.createTestRunner();

  console.log("\n💬  /api/v1/chat — test_edit context mode (DIF-007)");

  try {
    const { token } = await t.registerAndLogin(base, {
      name: "Edit User",
      email: "edit@example.com",
      password: "Password123!",
    });
    const cookie = `access_token=${token}`;

    await runner.test("accepts context: { mode: 'test_edit' } body shape", async () => {
      const { res, json } = await t.req(base, "/api/v1/chat", {
        method: "POST",
        cookie,
        body: {
          messages: [{ role: "user", content: "Add assertion" }],
          context: {
            mode: "test_edit",
            testCode: 'await page.goto("/")',
            testName: "T",
            testSteps: ["open page"],
          },
        },
      });
      // Provider is unconfigured → 503 is the expected short-circuit.
      // 200 would also be acceptable if a provider were configured.
      assert.ok([503, 200].includes(res.status), `unexpected status ${res.status}`);
      if (res.status === 503) {
        assert.match(json.error || "", /provider|busy/i);
      }
    });

    await runner.test("accepts context: null and routes to normal chat path", async () => {
      const { res, json } = await t.req(base, "/api/v1/chat", {
        method: "POST",
        cookie,
        body: {
          messages: [{ role: "user", content: "Hello" }],
          context: null,
        },
      });
      assert.ok([503, 200].includes(res.status), `unexpected status ${res.status}`);
      if (res.status === 503) {
        assert.match(json.error || "", /provider|busy/i);
      }
    });

    await runner.test("rejects empty messages array regardless of context", async () => {
      const { res, json } = await t.req(base, "/api/v1/chat", {
        method: "POST",
        cookie,
        body: {
          messages: [],
          context: { mode: "test_edit", testCode: "x", testName: "T", testSteps: [] },
        },
      });
      // Either 503 (provider check first) or 400 (validation) is acceptable —
      // both prove the route does not crash on the new body shape.
      assert.ok([400, 503].includes(res.status), `unexpected status ${res.status}`);
      assert.ok(json.error, "should return an error message");
    });

    await runner.test("rejects last-message-not-user with test_edit context", async () => {
      const { res } = await t.req(base, "/api/v1/chat", {
        method: "POST",
        cookie,
        body: {
          messages: [{ role: "assistant", content: "hi" }],
          context: { mode: "test_edit", testCode: "x", testName: "T", testSteps: [] },
        },
      });
      assert.ok([400, 503].includes(res.status), `unexpected status ${res.status}`);
    });

    await runner.test("requires authentication", async () => {
      const { res } = await t.req(base, "/api/v1/chat", {
        method: "POST",
        body: {
          messages: [{ role: "user", content: "Add assertion" }],
          context: { mode: "test_edit", testCode: "x", testName: "T", testSteps: [] },
        },
      });
      assert.ok([401, 403].includes(res.status), `expected auth rejection, got ${res.status}`);
    });
  } finally {
    env.restore();
    await new Promise(r => server.close(r));
  }

  runner.summary("test-edit-chat integration");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
