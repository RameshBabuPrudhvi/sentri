import assert from "node:assert/strict";
import { createTestRunner } from "./helpers/test-base.js";

const { test, summary } = createTestRunner();

test("rollback guard placeholder: agent_configs legacy columns still present for one release", async () => {
  const src = await (await import("node:fs/promises")).readFile(new URL("../src/database/repositories/agentConfigRepo.js", import.meta.url), "utf8");
  assert.match(src, /provider/);
  assert.match(src, /model/);
});

summary("Migration rollback");
