// AUTO-023 B5 — Zod-backed schema validation. Matches the contract
// `aiProvider/agentEnvelope.js` already uses for envelopes (single
// validation surface across the agent platform). Errors carry an
// `issues[]` array with `{path, message}` per `ZodError.issues` so a
// future LLM-driven retry path can pinpoint which field needs to
// change without re-parsing free-text error strings.
//
// Migration from hand-rolled validators: previously each schema was
// a closure that threw on first missing field, returning untyped
// `String()`-coerced objects. The Zod path:
//   • validates ALL fields in one pass (reports every issue at once)
//   • produces typed output (the inferred `.parse()` return type is
//     the canonical args shape — no more `String(args.projectId)`
//     coercion at every call site)
//   • emits structured errors the orchestrator surfaces to the LLM
//     verbatim, so `args.limit = "abc"` produces
//     `{ path: ["limit"], message: "Expected number, received nan" }`
//     instead of a vague `"limit must be a number"`
import { z } from "zod";

function fail(msg, code = "ERR_AGENT_TOOL_VALIDATION", issues = null) {
  const err = new Error(msg);
  err.code = code;
  if (issues) err.issues = issues;
  throw err;
}

const TOOL_SCHEMAS = {
  "db.listExistingTests": z.object({
    projectId: z.string().min(1, "projectId is required"),
    // AUTO-023 B5.7 — optional `limit` arg threaded into
    // `testRepo.getRecentByProjectId` so the SQL pushes the cap
    // instead of loading the full catalog and slicing in JS.
    // Clamped at the repo layer too (defence-in-depth).
    limit: z.coerce.number().int().positive().max(1000).optional().nullable(),
  }).strict(),
  "db.getTest": z.object({
    testId: z.string().min(1, "testId is required"),
  }).strict(),
  "crawl.getPageHtml": z.object({
    url: z.string().regex(/^https?:\/\//, "url must be http(s)"),
    runId: z.string().min(1, "runId is required"),
  }).strict(),
  "playwright.dryRun": z.object({
    testCode: z.string().min(1, "testCode is required"),
  }).strict(),
  "thread.askPeer": z.object({
    role: z.string().min(1, "role is required"),
    question: z.string().min(1, "question is required"),
  }).strict(),
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
  const schema = TOOL_SCHEMAS[tool];
  if (!schema) fail(`unknown tool: ${tool}`, "ERR_AGENT_TOOL_UNKNOWN");
  const parsed = schema.safeParse(args || {});
  if (parsed.success) return parsed.data;
  // Surface the FIRST issue's message in `.message` for compatibility
  // with the previous hand-rolled validator's contract (existing tests
  // assert e.g. `/projectId is required/`), and the FULL `issues[]`
  // array on `err.issues` for future LLM-driven retry callers.
  const issues = parsed.error.issues.map((i) => ({
    path: i.path,
    message: i.message,
    code: i.code,
  }));
  const summary = issues[0]?.message || "invalid tool args";
  fail(summary, "ERR_AGENT_TOOL_VALIDATION", issues);
}
