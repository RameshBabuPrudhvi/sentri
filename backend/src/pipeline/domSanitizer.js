import { structuredLog } from "../utils/logFormatter.js";

const AUTH_QUERY_PARAMS = ["token", "code", "access_token"];

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

export function sanitizeDomSnapshot(input, { allowlist = [], runId } = {}) {
  const placeholders = new Map();
  const counters = { email: 0, phone: 0, ssn: 0, card: 0, token: 0, jwt: 0, bearer: 0, queryAuth: 0 };
  const allow = Array.isArray(allowlist) ? allowlist.filter(Boolean) : [];
  const allowMatch = (v) => allow.some((rule) => v.includes(rule));
  const idFor = (k, label) => {
    if (!placeholders.has(k)) placeholders.set(k, `<${label}_${placeholders.size + 1}>`);
    return placeholders.get(k);
  };
  const redact = (text) => {
    if (!text || typeof text !== "string") return text;
    let out = text;
    out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (m) => allowMatch(m) ? m : (counters.email++, idFor(`email:${m}`, "EMAIL")));
    out = out.replace(/\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g, (m) => allowMatch(m) ? m : (counters.phone++, idFor(`phone:${m}`, "PHONE")));
    out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, (m) => allowMatch(m) ? m : (counters.ssn++, idFor(`ssn:${m}`, "SSN")));
    out = out.replace(/\b(?:\d[ -]*?){13,19}\b/g, (m) => {
      if (allowMatch(m) || !luhnValid(m)) return m;
      counters.card++;
      return idFor(`card:${m}`, "CARD");
    });
    out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, (m) => allowMatch(m) ? m : (counters.jwt++, counters.token++, idFor(`jwt:${m}`, "TOKEN")));
    out = out.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*\b/gi, (m) => allowMatch(m) ? m : (counters.bearer++, counters.token++, idFor(`auth:${m}`, "TOKEN")));
    out = out.replace(/([?&](?:token|code|access_token)=)([^&#\s]+)/gi, (_, p1, p2) => {
      if (allowMatch(p2)) return `${p1}${p2}`;
      counters.queryAuth++;
      counters.token++;
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
  structuredLog("pipeline.pii_redacted", { runId, counts: counters, total: Object.values(counters).reduce((a, b) => a + b, 0) });
  return { output, counts: counters };
}
