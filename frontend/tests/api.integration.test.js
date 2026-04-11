/**
 * @module tests/api-integration
 * @description Integration-style tests for frontend API client behavior.
 *
 * After the cookie-based auth migration (S1-02), the api.js module:
 *   - Sends `credentials: "include"` instead of an Authorization header
 *   - Reads the CSRF token from `document.cookie` (via utils/csrf.js)
 *   - On 401, clears `app_auth_user` from localStorage and redirects
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
  const originalDocument = global.document;

  const requests = [];

  global.localStorage = makeStorage({
    app_auth_user: JSON.stringify({ id: "U-1" }),
  });
  global.window = { location: { pathname: "/dashboard", href: "/dashboard" } };
  // Provide document.cookie so getCsrfToken() can read the CSRF token
  global.document = { cookie: "sentri_csrf=test-csrf-token" };
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
    // Cookie-based auth: no Authorization header, but credentials: "include" is set
    assert.equal(requests[0].init.credentials, "include", "Should send credentials: include");
    assert.equal(requests[0].init.headers.Authorization, undefined, "Should NOT send Authorization header");

    let unauthorizedError = null;
    try {
      await api.getRun("RUN-1");
    } catch (err) {
      unauthorizedError = err;
    }

    assert.ok(unauthorizedError instanceof Error, "Expected unauthorized request to throw");
    assert.match(unauthorizedError.message, /Session expired/i);
    assert.equal(global.localStorage.getItem("app_auth_user"), null, "User profile should be cleared on 401");
    assert.match(global.window.location.href, /\/login$/);

    console.log("✅ api-integration: all checks passed");
  } finally {
    global.fetch = originalFetch;
    global.window = originalWindow;
    global.localStorage = originalLocalStorage;
    global.document = originalDocument;
  }
}

run().catch((err) => {
  console.error("❌ api-integration failed:", err);
  process.exit(1);
});
