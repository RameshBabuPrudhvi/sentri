import fs from "node:fs";
import path from "node:path";

const DEFAULT_RULES = [
  { id: "aws-access-key-id", description: "AWS access key id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "jwt-token", description: "JWT token", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g },
  { id: "bearer-token", description: "Bearer token", regex: /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi },
];

let cachedRules = null;

function repoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
}

function parseCustomRules(tomlText) {
  const parsed = [];
  const chunks = tomlText.split("[[rules]]").slice(1);
  for (const chunk of chunks) {
    const id = chunk.match(/^\s*id\s*=\s*"([^"]+)"/m)?.[1] || "custom-rule";
    const description = chunk.match(/^\s*description\s*=\s*"([^"]+)"/m)?.[1] || id;
    const pattern = chunk.match(/^\s*regex\s*=\s*'([^']+)'/m)?.[1] || chunk.match(/^\s*regex\s*=\s*"([^"]+)"/m)?.[1];
    if (!pattern) continue;
    try {
      parsed.push({ id, description, regex: new RegExp(pattern, "g") });
    } catch {
      // ignore invalid custom regex entries
    }
  }
  return parsed;
}

export function loadSecretRules() {
  if (cachedRules) return cachedRules;
  const file = path.join(repoRoot(), ".github", ".gitleaks.toml");
  let custom = [];
  try {
    const toml = fs.readFileSync(file, "utf8");
    custom = parseCustomRules(toml);
  } catch {
    custom = [];
  }
  cachedRules = [...DEFAULT_RULES, ...custom];
  return cachedRules;
}

function redact(value) {
  if (!value) return "";
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function scanForSecrets(code) {
  if (!code || typeof code !== "string") return [];
  const findings = [];
  const rules = loadSecretRules();
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    const m = rule.regex.exec(code);
    if (!m) continue;
    findings.push({
      ruleId: rule.id,
      description: rule.description,
      match: redact(m[0]),
      message: `secret-like token detected (${rule.id}): ${redact(m[0])}`,
    });
  }
  return findings;
}
