import { structuredLog } from "../utils/logFormatter.js";

function luhnValid(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Create a sanitizer context. Pass the same context into multiple
 * {@link sanitizeDomSnapshot} calls to guarantee that identical input
 * values resolve to identical placeholder IDs across all calls (so the AI
 * can correlate references across snapshots + classified pages).
 *
 * @param {{ allowlist?: string[], runId?: string }} [opts]
 */
export function createPiiContext({ allowlist = [], runId } = {}) {
  return {
    allowlist: Array.isArray(allowlist) ? allowlist.filter((v) => typeof v === "string" && v.length > 0) : [],
    placeholders: new Map(),
    seq: { EMAIL: 0, PHONE: 0, SSN: 0, CARD: 0, TOKEN: 0 },
    counters: { email: 0, phone: 0, ssn: 0, card: 0, token: 0, jwt: 0, bearer: 0, queryAuth: 0 },
    runId,
  };
}

/**
 * Emit the per-run `pipeline.pii_redacted` audit log. `total` sums only
 * the five non-overlapping categories (email/phone/ssn/card/token) —
 * `jwt`, `bearer`, and `queryAuth` are subdivisions of `token` and would
 * double-count if added to the aggregate.
 */
export function finalizePiiContext(ctx) {
  const { counters } = ctx;
  const total = counters.email + counters.phone + counters.ssn + counters.card + counters.token;
  structuredLog("pipeline.pii_redacted", { runId: ctx.runId, counts: counters, total });
}

/**
 * Sanitize an input value (string, array, or plain object — walked
 * recursively) by replacing PII matches with deterministic placeholders.
 *
 * Two call forms:
 *  - `sanitizeDomSnapshot(input, ctx)` — caller-owned context (created via
 *    {@link createPiiContext}); no audit log is emitted here. The caller
 *    invokes {@link finalizePiiContext} once after the final call to log
 *    aggregate counts for the run. Use this form when multiple artifacts
 *    must share placeholder IDs.
 *  - `sanitizeDomSnapshot(input, { allowlist, runId })` — convenience form
 *    that creates a fresh context internally and emits its own audit log.
 *    Counters and placeholders are NOT shared with later calls.
 *
 * @param {*} input
 * @param {object} [ctxOrOpts] — either a context object from
 *   {@link createPiiContext} (detected via internal `placeholders` Map) or
 *   `{ allowlist, runId }` to create a one-shot context.
 * @returns {{ output: *, counts: object, ctx: object }}
 */
export function sanitizeDomSnapshot(input, ctxOrOpts = {}) {
  // Detect a caller-owned context via the presence of the internal
  // `placeholders` Map — opts objects only ever carry `allowlist` / `runId`.
  const ownsContext = !ctxOrOpts || !(ctxOrOpts.placeholders instanceof Map);
  const ctx = ownsContext ? createPiiContext(ctxOrOpts) : ctxOrOpts;

  const allowMatch = (v) => ctx.allowlist.some((rule) => v.includes(rule));
  const idFor = (k, label) => {
    if (!ctx.placeholders.has(k)) {
      ctx.seq[label] += 1;
      ctx.placeholders.set(k, `<${label}_${ctx.seq[label]}>`);
    }
    return ctx.placeholders.get(k);
  };
  const redact = (text) => {
    if (!text || typeof text !== "string") return text;
    let out = text;
    out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (m) => allowMatch(m) ? m : (ctx.counters.email++, idFor(`email:${m.toLowerCase()}`, "EMAIL")));
    out = out.replace(/\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g, (m) => allowMatch(m) ? m : (ctx.counters.phone++, idFor(`phone:${m}`, "PHONE")));
    out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, (m) => allowMatch(m) ? m : (ctx.counters.ssn++, idFor(`ssn:${m}`, "SSN")));
    out = out.replace(/\b(?:\d[ -]*?){13,19}\b/g, (m) => {
      if (allowMatch(m) || !luhnValid(m)) return m;
      ctx.counters.card++;
      return idFor(`card:${m}`, "CARD");
    });
    out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, (m) => allowMatch(m) ? m : (ctx.counters.jwt++, ctx.counters.token++, idFor(`jwt:${m}`, "TOKEN")));
    out = out.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*\b/gi, (m) => allowMatch(m) ? m : (ctx.counters.bearer++, ctx.counters.token++, idFor(`auth:${m}`, "TOKEN")));
    out = out.replace(/([?&](?:token|code|access_token)=)([^&#\s]+)/gi, (_, p1, p2) => {
      if (allowMatch(p2)) return `${p1}${p2}`;
      ctx.counters.queryAuth++;
      ctx.counters.token++;
      return `${p1}${idFor(`query:${p2}`, "TOKEN")}`;
    });
    return out;
  };
  const walk = (v) => {
    if (typeof v === "string") return redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    return v;
  };
  const output = walk(input);
  if (ownsContext) {
    finalizePiiContext(ctx);
  }
  return { output, counts: ctx.counters, ctx };
}
