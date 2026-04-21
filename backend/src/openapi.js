/**
 * @module openapi
 * @description OpenAPI 3.1 spec for the Sentri REST API (INF-004).
 *
 * Served at `GET /api/v1/openapi.json` and rendered via Swagger UI
 * at `/api/docs`.
 *
 * @exports spec
 */

// ── Helpers ──────────────────────────────────────────────────────────────────
const P = (n, loc = "path") => ({ name: n, in: loc, required: true, schema: { type: "string" } });
const J = (s) => ({ required: true, content: { "application/json": { schema: s } } });
const ok = (d = "OK") => ({ 200: { description: d } });
const pid = [P("id")];

/** @type {Object} */
export const spec = {
  openapi: "3.1.0",
  info: {
    title: "Sentri API",
    version: "1.6.0",
    description: "Full-lifecycle AI QA platform. All endpoints under `/api/v1/`.",
    license: { name: "MIT" },
  },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "Auth" }, { name: "Projects" }, { name: "Tests" }, { name: "Runs" },
    { name: "Dashboard" }, { name: "Schedules" }, { name: "Notifications" },
    { name: "Trigger" }, { name: "Workspaces" }, { name: "Settings" },
    { name: "System" }, { name: "Chat" }, { name: "Recycle Bin" },
  ],
  components: {
    securitySchemes: {
      cookieAuth: { type: "apiKey", in: "cookie", name: "access_token" },
      triggerToken: { type: "http", scheme: "bearer" },
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
      Project: { type: "object", properties: { id: { type: "string", example: "PRJ-1" }, name: { type: "string" }, url: { type: "string" }, status: { type: "string" }, createdAt: { type: "string", format: "date-time" } } },
      Test: { type: "object", properties: { id: { type: "string", example: "TC-1" }, projectId: { type: "string" }, name: { type: "string" }, steps: { type: "array", items: { type: "string" } }, reviewStatus: { type: "string", enum: ["draft", "approved", "rejected"] } } },
      Run: { type: "object", properties: { id: { type: "string", example: "RUN-1" }, projectId: { type: "string" }, type: { type: "string", enum: ["crawl", "test_run", "generate"] }, status: { type: "string", enum: ["running", "completed", "failed", "aborted"] }, passed: { type: "integer", nullable: true }, failed: { type: "integer", nullable: true }, total: { type: "integer", nullable: true } } },
    },
  },
  security: [{ cookieAuth: [] }],
  paths: {
    "/auth/register": { post: { tags: ["Auth"], summary: "Register", security: [], requestBody: J({ type: "object", required: ["name", "email", "password"], properties: { name: { type: "string" }, email: { type: "string" }, password: { type: "string" } } }), responses: { 200: { description: "Created" }, 409: { description: "Email taken" } } } },
    "/auth/login": { post: { tags: ["Auth"], summary: "Log in", security: [], requestBody: J({ type: "object", required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string" } } }), responses: { 200: { description: "OK" }, 401: { description: "Bad credentials" }, 403: { description: "Unverified" } } } },
    "/auth/logout": { post: { tags: ["Auth"], summary: "Log out", responses: ok() } },
    "/auth/refresh": { post: { tags: ["Auth"], summary: "Refresh JWT", responses: ok() } },
    "/auth/forgot-password": { post: { tags: ["Auth"], summary: "Request reset", security: [], requestBody: J({ type: "object", required: ["email"], properties: { email: { type: "string" } } }), responses: ok() } },
    "/auth/reset-password": { post: { tags: ["Auth"], summary: "Reset password", security: [], requestBody: J({ type: "object", required: ["token", "newPassword"], properties: { token: { type: "string" }, newPassword: { type: "string" } } }), responses: { 200: { description: "OK" }, 400: { description: "Bad token" } } } },
    "/auth/verify": { get: { tags: ["Auth"], summary: "Verify email", security: [], parameters: [P("token", "query")], responses: ok("Verified") } },
    "/auth/resend-verification": { post: { tags: ["Auth"], summary: "Resend verification", security: [], requestBody: J({ type: "object", required: ["email"], properties: { email: { type: "string" } } }), responses: ok("Sent") } },
    "/auth/export": { get: { tags: ["Auth"], summary: "Export data (GDPR)", parameters: [{ name: "X-Account-Password", in: "header", required: true, schema: { type: "string" } }], responses: ok("JSON archive") } },
    "/auth/account": { delete: { tags: ["Auth"], summary: "Delete account (GDPR)", requestBody: J({ type: "object", required: ["password"], properties: { password: { type: "string" } } }), responses: ok("Deleted") } },
    "/projects": { get: { tags: ["Projects"], summary: "List", responses: ok() }, post: { tags: ["Projects"], summary: "Create", requestBody: J({ type: "object", required: ["name", "url"], properties: { name: { type: "string" }, url: { type: "string" } } }), responses: { 201: { description: "Created" } } } },
    "/projects/{id}": { parameters: pid, get: { tags: ["Projects"], summary: "Get", responses: ok() }, patch: { tags: ["Projects"], summary: "Update", responses: ok() }, delete: { tags: ["Projects"], summary: "Delete", responses: ok() } },
    "/projects/{id}/tests": { parameters: pid, get: { tags: ["Tests"], summary: "List tests", responses: ok() }, post: { tags: ["Tests"], summary: "Create test", requestBody: J({ type: "object", required: ["name"], properties: { name: { type: "string" }, steps: { type: "array", items: { type: "string" } } } }), responses: { 201: { description: "Created" } } } },
    "/projects/{id}/tests/counts": { parameters: pid, get: { tags: ["Tests"], summary: "Counts", responses: ok() } },
    "/projects/{id}/tests/bulk": { parameters: pid, post: { tags: ["Tests"], summary: "Bulk action", requestBody: J({ type: "object", required: ["testIds", "action"], properties: { testIds: { type: "array", items: { type: "string" } }, action: { type: "string", enum: ["approve", "reject", "restore", "delete"] } } }), responses: ok() } },
    "/projects/{id}/tests/generate": { parameters: pid, post: { tags: ["Tests"], summary: "AI-generate", requestBody: J({ type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" } } }), responses: { 202: { description: "Started" } } } },
    "/projects/{id}/tests/{testId}": { parameters: [P("id"), P("testId")], delete: { tags: ["Tests"], summary: "Delete test", responses: ok() } },
    "/projects/{id}/tests/{testId}/approve": { parameters: [P("id"), P("testId")], patch: { tags: ["Tests"], summary: "Approve", responses: ok() } },
    "/projects/{id}/tests/{testId}/reject": { parameters: [P("id"), P("testId")], patch: { tags: ["Tests"], summary: "Reject", responses: ok() } },
    "/projects/{id}/tests/{testId}/restore": { parameters: [P("id"), P("testId")], patch: { tags: ["Tests"], summary: "Restore", responses: ok() } },
    "/tests": { get: { tags: ["Tests"], summary: "All tests", responses: ok() } },
    "/tests/{testId}": { parameters: [P("testId")], get: { tags: ["Tests"], summary: "Get", responses: ok() }, patch: { tags: ["Tests"], summary: "Edit", responses: ok() } },
    "/tests/{testId}/run": { parameters: [P("testId")], post: { tags: ["Runs"], summary: "Run single test", responses: ok() } },
    "/tests/{testId}/fix": { parameters: [P("testId")], post: { tags: ["Tests"], summary: "AI-fix (SSE)", responses: ok("SSE stream") } },
    "/tests/{testId}/apply-fix": { parameters: [P("testId")], post: { tags: ["Tests"], summary: "Apply fix", responses: ok() } },
    "/projects/{id}/crawl": { parameters: pid, post: { tags: ["Runs"], summary: "Start crawl", responses: ok() } },
    "/projects/{id}/run": { parameters: pid, post: { tags: ["Runs"], summary: "Run approved tests", responses: ok() } },
    "/projects/{id}/runs": { parameters: pid, get: { tags: ["Runs"], summary: "List runs", responses: ok() } },
    "/runs/{runId}": { parameters: [P("runId")], get: { tags: ["Runs"], summary: "Get run", responses: ok() } },
    "/runs/{runId}/abort": { parameters: [P("runId")], post: { tags: ["Runs"], summary: "Abort", responses: ok() } },
    "/projects/{id}/schedule": { parameters: pid, get: { tags: ["Schedules"], summary: "Get", responses: ok() }, patch: { tags: ["Schedules"], summary: "Set", responses: ok() }, delete: { tags: ["Schedules"], summary: "Remove", responses: ok() } },
    "/projects/{id}/notifications": { parameters: pid, get: { tags: ["Notifications"], summary: "Get", responses: ok() }, patch: { tags: ["Notifications"], summary: "Upsert", responses: ok() }, delete: { tags: ["Notifications"], summary: "Remove", responses: ok() } },
    "/projects/{id}/trigger": { parameters: pid, post: { tags: ["Trigger"], summary: "CI/CD trigger", security: [{ triggerToken: [] }], responses: { 202: { description: "Accepted" } } } },
    "/projects/{id}/trigger-tokens": { parameters: pid, get: { tags: ["Trigger"], summary: "List tokens", responses: ok() }, post: { tags: ["Trigger"], summary: "Create token", responses: { 201: { description: "Created" } } } },
    "/projects/{id}/trigger-tokens/{tid}": { parameters: [P("id"), P("tid")], delete: { tags: ["Trigger"], summary: "Revoke", responses: ok() } },
    "/workspaces": { get: { tags: ["Workspaces"], summary: "List", responses: ok() } },
    "/workspaces/current": { get: { tags: ["Workspaces"], summary: "Current", responses: ok() }, patch: { tags: ["Workspaces"], summary: "Update", responses: ok() } },
    "/workspaces/current/members": { get: { tags: ["Workspaces"], summary: "Members", responses: ok() }, post: { tags: ["Workspaces"], summary: "Invite", responses: ok() } },
    "/workspaces/switch": { post: { tags: ["Workspaces"], summary: "Switch", responses: ok() } },
    "/dashboard": { get: { tags: ["Dashboard"], summary: "Analytics", responses: ok() } },
    "/config": { get: { tags: ["Settings"], summary: "Active provider", responses: ok() } },
    "/settings": { get: { tags: ["Settings"], summary: "Masked keys", responses: ok() }, post: { tags: ["Settings"], summary: "Save key", responses: ok() } },
    "/settings/{provider}": { parameters: [P("provider")], delete: { tags: ["Settings"], summary: "Remove key", responses: ok() } },
    "/ollama/status": { get: { tags: ["Settings"], summary: "Ollama status", responses: ok() } },
    "/activities": { get: { tags: ["System"], summary: "Activity log", responses: ok() } },
    "/system": { get: { tags: ["System"], summary: "System info", responses: ok() } },
    "/test-connection": { post: { tags: ["System"], summary: "URL reachability", requestBody: J({ type: "object", required: ["url"], properties: { url: { type: "string" } } }), responses: ok() } },
    "/data/runs": { delete: { tags: ["System"], summary: "Clear runs", responses: ok() } },
    "/data/activities": { delete: { tags: ["System"], summary: "Clear activities", responses: ok() } },
    "/data/healing": { delete: { tags: ["System"], summary: "Clear healing", responses: ok() } },
    "/chat": { post: { tags: ["Chat"], summary: "AI chat (SSE)", responses: ok("SSE stream") } },
    "/recycle-bin": { get: { tags: ["Recycle Bin"], summary: "List deleted", responses: ok() } },
    "/restore/{type}/{id}": { parameters: [P("type"), P("id")], post: { tags: ["Recycle Bin"], summary: "Restore", responses: ok() } },
    "/purge/{type}/{id}": { parameters: [P("type"), P("id")], delete: { tags: ["Recycle Bin"], summary: "Purge", responses: ok() } },
  },
};
