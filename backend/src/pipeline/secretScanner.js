/**
 * @module pipeline/secretScanner
 * @description
 * CAP-003 — `gitleaks`-style secret scanner used by the post-generation
 * validation stage to reject AI-generated Playwright tests that embed
 * credentials harvested during crawl (Authorization headers, API keys,
 * JWTs, AWS access keys). Findings are always redacted before surfacing —
 * the raw match value is never echoed back into the issues list or
 * persisted on the test record.
 *
 * Built-in detectors cover AWS access key IDs, JWTs, and `Bearer` tokens.
 * Additional rules are loaded best-effort from the repo's existing
 * `.github/.gitleaks.toml` so the CI ruleset is reused.
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_RULES = [
  { id: "aws-access-key-id", description: "AWS access key id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "jwt-token", description: "JWT token", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g },
  { id: "bearer-token", description: "Bearer token", regex: /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi },
];

let cachedRules = null;

/**
 * Resolve the repository root from this module's URL. Used to locate the
 * shared `.github/.gitleaks.toml` config without hard-coding `process.cwd()`
 * (which would break when the server is launched from a non-repo-root cwd).
 *
 * @returns {string} Absolute path to the repo root.
 * @private
 */
function repoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
}

/**
 * Naive `[[rules]]` chunker for `.github/.gitleaks.toml`. Not a full TOML
 * parser — extracts only `id`, `description`, and `regex` fields per rule
 * via simple line-anchored regexes. Multi-line strings, escapes, and other
 * TOML features are intentionally unsupported (best-effort reuse). Invalid
 * regex patterns are silently skipped so a malformed custom rule cannot
 * break the entire scanner.
 *
 * @param {string} tomlText Raw `.gitleaks.toml` file contents.
 * @returns {Array<{id: string, description: string, regex: RegExp}>}
 * @private
 */
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

/**
 * Load and cache the active secret-detection ruleset.
 *
 * Returns the merged list of `DEFAULT_RULES` plus any custom rules parsed
 * best-effort from `.github/.gitleaks.toml`. Result is memoised in
 * module-level `cachedRules` for the lifetime of the process — config
 * changes require a server restart.
 *
 * @returns {Array<{id: string, description: string, regex: RegExp}>}
 */
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

/**
 * Redact a matched secret value so it can be safely surfaced in logs,
 * issue strings, and persisted finding records. Values longer than 8
 * characters are shortened to `<first4>…<last4>`; shorter values are
 * fully replaced with `[REDACTED]`. The raw value never crosses the
 * scanner boundary.
 *
 * @param {string} value Raw matched secret.
 * @returns {string} Redacted, display-safe representation.
 */
function redact(value) {
  if (!value) return "";
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Scan a string of generated Playwright code for credential-like tokens.
 *
 * Runs every active rule against the input and returns a redacted
 * findings array (`{ ruleId, description, match, message }`). All
 * occurrences of every rule are emitted so reviewers see the full set
 * of leaked credentials, not just the first match. Empty / non-string
 * input returns an empty array.
 *
 * @param {string} code Generated Playwright source to scan.
 * @returns {Array<{ruleId: string, description: string, match: string, message: string}>}
 */
export function scanForSecrets(code) {
  if (!code || typeof code !== "string") return [];
  const findings = [];
  const rules = loadSecretRules();
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    let m;
    while ((m = rule.regex.exec(code)) !== null) {
      findings.push({
        ruleId: rule.id,
        description: rule.description,
        match: redact(m[0]),
        message: `secret-like token detected (${rule.id}): ${redact(m[0])}`,
      });
      // Guard against zero-width matches causing an infinite loop.
      if (m.index === rule.regex.lastIndex) rule.regex.lastIndex += 1;
    }
  }
  return findings;
}
