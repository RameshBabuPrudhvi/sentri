import assert from "node:assert/strict";
import { requestContext } from "../src/utils/observability.js";
import { formatLogLine } from "../src/utils/logFormatter.js";

const line = requestContext.run({ requestId: "req-test-1" }, () => formatLogLine("info", null, "hello"));
assert.equal(line.includes("req-test-1"), true);

console.log("observability.test.js passed");
