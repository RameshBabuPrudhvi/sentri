function fail(msg, code = "ERR_AGENT_TOOL_VALIDATION") {
  const err = new Error(msg);
  err.code = code;
  throw err;
}

const TOOL_SCHEMAS = {
  "db.listExistingTests": (args) => {
    if (!args?.projectId) fail("projectId is required");
    // AUTO-023 B5.7 — optional `limit` arg threaded into
    // `testRepo.getRecentByProjectId` so the SQL pushes the cap
    // instead of loading the full catalog and slicing in JS.
    // Clamped at the repo layer too (defence-in-depth).
    const limitRaw = args?.limit;
    const limit = limitRaw == null ? null : Number.parseInt(String(limitRaw), 10);
    return {
      projectId: String(args.projectId),
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    };
  },
  "db.getTest": (args) => {
    if (!args?.testId) fail("testId is required");
    return { testId: String(args.testId) };
  },
  "crawl.getPageHtml": (args) => {
    if (!args?.url || !/^https?:\/\//.test(String(args.url))) fail("url must be http(s)");
    if (!args?.runId) fail("runId is required");
    return { url: String(args.url), runId: String(args.runId) };
  },
  "playwright.dryRun": (args) => {
    if (!args?.testCode) fail("testCode is required");
    return { testCode: String(args.testCode) };
  },
  "thread.askPeer": (args) => {
    if (!args?.role) fail("role is required");
    if (!args?.question) fail("question is required");
    return { role: String(args.role), question: String(args.question) };
  },
};

const TOOL_ROLES = {
  explorer: ["crawl.getPageHtml", "thread.askPeer"],
  planner: ["thread.askPeer"],
  author: ["db.listExistingTests", "playwright.dryRun", "thread.askPeer"],
  reviewer: ["db.getTest", "playwright.dryRun", "thread.askPeer"],
  oracle: ["thread.askPeer"],
  supervisor: ["thread.askPeer"],
  triager: ["thread.askPeer"],
  healer: ["thread.askPeer"],
  default: ["thread.askPeer"],
};

export function listToolsForRole(role, allowedTools = null) {
  const base = TOOL_ROLES[role] || TOOL_ROLES.default;
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) return base;
  const allowed = new Set(allowedTools);
  return base.filter((t) => allowed.has(t));
}

export function validateToolCall(tool, args) {
  const parser = TOOL_SCHEMAS[tool];
  if (!parser) fail(`unknown tool: ${tool}`, "ERR_AGENT_TOOL_UNKNOWN");
  return parser(args || {});
}
