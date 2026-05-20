import test from "node:test";
import assert from "node:assert/strict";

import * as anthropic from "../src/aiProvider/adapters/anthropic.js";
import * as openai from "../src/aiProvider/adapters/openai.js";
import * as google from "../src/aiProvider/adapters/google.js";
import * as ollama from "../src/aiProvider/adapters/ollama.js";

for (const [name, adapter] of Object.entries({ anthropic, openai, google, ollama })) {
  test(`${name} adapter exports contract methods`, () => {
    assert.equal(typeof adapter.generate, "function");
    assert.equal(typeof adapter.stream, "function");
    assert.equal(typeof adapter.generateVision, "function");
  });
}
