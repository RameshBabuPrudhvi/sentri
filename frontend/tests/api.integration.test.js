/**
 * @module tests/api-integration
 * @description Integration-style tests for frontend API client behavior.
 */

import assert from "node:assert/strict";

function makeStorage(seed = {}) {
  const state = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return state.has(key) ? state.get(key) : null;
    },
    setItem(key, value) {
      state.set(key, String(value));
    },
    removeItem(key) {
      state.delete(key);
    },
  };
}

function makeJsonResponse(status, payload, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? "Unauthorized" : "Error",
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? contentType : null;
      },
    },
    async json() {
      return payload;
    },
  };
}

async function run() {
  const originalFetch = global.fetch;
  const originalWindow = global.window;
  const originalLocalStorage = global.localStorage;

  const requests = [];

  global.localStorage = makeStorage({
    app_auth_token: "test-token",
    app_auth_user: JSON.stringify({ id: "U-1" }),
  });
  global.window = { location: { pathname: "/dashboard", href: "/dashboard" } };
  global.fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith("/api/projects")) {
      return makeJsonResponse(200, [{ id: "PRJ-1" }]);
    }
    if (url.endsWith("/api/runs/RUN-1") && init.method === "GET") {
      return makeJsonResponse(401, { error: "Unauthorized" });
    }
    return makeJsonResponse(500, { error: "Unexpected path" });
  };

  try {
    const { api } = await import("../src/api.js");

    const projects = await api.getProjects();
    assert.equal(Array.isArray(projects), true);
    assert.equal(projects[0].id, "PRJ-1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.headers.Authorization, "Bearer test-token");

    let unauthorizedError = null;
    try {
      await api.getRun("RUN-1");
    } catch (err) {
      unauthorizedError = err;
    }

    assert.ok(unauthorizedError instanceof Error, "Expected unauthorized request to throw");
    assert.match(unauthorizedError.message, /Session expired/i);
    assert.equal(global.localStorage.getItem("app_auth_token"), null);
    assert.equal(global.localStorage.getItem("app_auth_user"), null);
    assert.match(global.window.location.href, /\/login$/);

    console.log("✅ api-integration: all checks passed");
  } finally {
    global.fetch = originalFetch;
    global.window = originalWindow;
    global.localStorage = originalLocalStorage;
  }
}

run().catch((err) => {
  console.error("❌ api-integration failed:", err);
  process.exit(1);
});
