/**
 * @module integrations/githubChecks
 * @description GitHub App Check Run client with cached installation tokens (INT-002).
 */

import crypto from "node:crypto";
import { signJwt, verifyJwt, getJwtSecret } from "../middleware/authenticate.js";
import { redis, isRedisAvailable } from "../utils/redisClient.js";
import { formatLogLine } from "../utils/logFormatter.js";

const CHECK_NAME = process.env.GITHUB_CHECK_NAME || "Sentri QA";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const tokenCache = new Map();
const installStateCache = new Map();
const INSTALL_STATE_TTL_SEC = 600;
let inMemoryNonceWarned = false;

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function getPrivateKey() {
  const key = process.env.GITHUB_APP_PRIVATE_KEY || "";
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

function createAppJwt(now = Math.floor(Date.now() / 1000)) {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = getPrivateKey();
  if (!appId || !privateKey) throw new Error("GitHub App credentials are not configured");
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

// Retry policy for transient upstream errors. GitHub's API returns:
//   - 502 / 503 / 504 on edge-network issues (rare, ~seconds)
//   - 429 on secondary rate-limit (tens of seconds; honour Retry-After)
//   - 403 with `x-ratelimit-remaining: 0` on primary rate-limit
// A non-retried single 5xx would lose the check-run entirely on a busy CI
// fleet — industry-standard QA gates retry the GitHub API with bounded
// exponential backoff. We cap at 3 attempts and 4s total so the trigger
// path (which awaits this) doesn't block the run for long.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

function retryAfterMs(res) {
  const header = res.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 4000);
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), 4000));
  return null;
}

async function githubFetch(path, { method = "GET", token, body, fetchImpl = fetch } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const apiBase = process.env.GITHUB_API_BASE || "https://api.github.com";
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "sentri-github-checks",
        "X-GitHub-Api-Version": "2022-11-28",
        "Authorization": `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();

    const text = await res.text().catch(() => "");
    lastErr = new Error(`GitHub API ${res.status}: ${text || res.statusText}`);
    lastErr.status = res.status;

    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) throw lastErr;
    const wait = retryAfterMs(res) ?? Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), 2000);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr;
}

/**
 * Clear cached installation tokens. Intended for tests.
 * @returns {void}
 */
export function clearInstallationTokenCache() {
  tokenCache.clear();
}

/**
 * Clear cached one-shot GitHub install state nonces. Intended for tests.
 * @returns {void}
 */
export function clearInstallStateCache() {
  installStateCache.clear();
  inMemoryNonceWarned = false;
}

/**
 * Return a cached GitHub App installation token, refreshing before expiry.
 *
 * @param {string|number} installationId
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<string>}
 */
export async function getInstallationToken(installationId, { fetchImpl = fetch } = {}) {
  if (!installationId) throw new Error("GitHub installationId is required");
  const cacheKey = String(installationId);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) return cached.token;

  const jwt = createAppJwt();
  const data = await githubFetch(`/app/installations/${encodeURIComponent(cacheKey)}/access_tokens`, {
    method: "POST",
    token: jwt,
    fetchImpl,
  });
  const expiresAtMs = Date.parse(data.expires_at || "");
  tokenCache.set(cacheKey, {
    token: data.token,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 50 * 60_000,
  });
  return data.token;
}


function installStateKey(nonce) {
  return `github-install-state:${nonce}`;
}

async function storeInstallNonce(nonce, ttlSec) {
  if (isRedisAvailable() && redis) {
    await redis.set(installStateKey(nonce), "1", "EX", ttlSec, "NX");
    return;
  }
  // In-memory fallback is process-local: in a multi-replica deploy without
  // Redis, an attacker who captured a redirect URL could potentially replay
  // it against a different replica that has never seen the nonce. Warn once
  // so operators notice in production logs; single-replica / dev setups are
  // safe. Industry-standard fix is to provision Redis (see REDIS_URL).
  if (!inMemoryNonceWarned) {
    inMemoryNonceWarned = true;
    console.warn(formatLogLine(
      "warn",
      "",
      "[github-install] Redis unavailable; install-state replay protection is process-local. "
        + "Set REDIS_URL for multi-replica deployments — see docs/api/projects.md § GitHub App Integration.",
    ));
  }
  installStateCache.set(nonce, Date.now() + ttlSec * 1000);
}

async function claimInstallNonce(nonce) {
  if (!nonce) return false;
  if (isRedisAvailable() && redis) {
    const removed = await redis.del(installStateKey(nonce));
    return removed === 1;
  }
  const expiresAt = installStateCache.get(nonce);
  installStateCache.delete(nonce);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function peekInstallNonce(nonce) {
  if (!nonce) return false;
  if (isRedisAvailable() && redis) {
    const exists = await redis.exists(installStateKey(nonce));
    return exists === 1;
  }
  const expiresAt = installStateCache.get(nonce);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

/**
 * Sign a short-lived, one-shot state token for the GitHub App install flow.
 *
 * The state JWT is the only auth on the callback route because GitHub
 * redirects the user back from `github.com` — a cross-site navigation that
 * browsers refuse to attach `SameSite=Strict` cookies to (the default for
 * same-origin Sentri deployments). The signed nonce-tracked state proves
 * an authenticated admin initiated the flow; the embedded `actor` fields
 * let the callback log who completed the install without `req.authUser`.
 *
 * @param {string} projectId
 * @param {Object} [options]
 * @param {number} [options.ttlSec=600]
 * @param {Object} [options.actor]
 *   Optional authenticated user metadata captured at sign-time so the
 *   callback can attribute the activity log entry.
 * @param {string} [options.actor.userId]
 * @param {string} [options.actor.userName]
 * @returns {Promise<string>} Signed state JWT.
 */
export async function signInstallState(projectId, { ttlSec = INSTALL_STATE_TTL_SEC, actor = {} } = {}) {
  if (!projectId) throw new Error("projectId is required");
  const nonce = crypto.randomUUID();
  await storeInstallNonce(nonce, ttlSec);
  return signJwt(
    {
      projectId,
      nonce,
      purpose: "github-install",
      actorId: actor.userId || null,
      actorName: actor.userName || null,
    },
    getJwtSecret(),
    ttlSec,
  );
}

/**
 * Verify a GitHub App install state token.
 *
 * By default the nonce is claimed (consumed) on verification — the token is
 * one-shot. Callers that need to perform fallible work (e.g. GitHub API
 * calls) between verification and final acceptance can pass `{ claim: false }`
 * to defer consumption and then call `claimInstallState(nonce)` after the
 * fallible work succeeds; this prevents a transient upstream failure from
 * permanently spending the state JWT and forcing the user to restart the
 * entire install flow.
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {boolean} [options.claim=true] When false, the nonce is left in
 *   place; the caller is responsible for calling `claimInstallState(nonce)`.
 * @returns {Promise<{projectId: string, nonce: string, actorId: string|null, actorName: string|null}|null>}
 */
export async function verifyInstallState(token, { claim = true } = {}) {
  const payload = verifyJwt(token, getJwtSecret());
  if (!payload || payload.purpose !== "github-install" || !payload.projectId || !payload.nonce) return null;
  if (claim) {
    if (!await claimInstallNonce(payload.nonce)) return null;
  } else if (!await peekInstallNonce(payload.nonce)) {
    return null;
  }
  return {
    projectId: payload.projectId,
    nonce: payload.nonce,
    actorId: payload.actorId || null,
    actorName: payload.actorName || null,
  };
}

/**
 * Claim (consume) a previously-verified install-state nonce. Used by callers
 * that passed `{ claim: false }` to `verifyInstallState` and have now
 * completed their fallible work.
 *
 * @param {string} nonce
 * @returns {Promise<boolean>} True if the nonce was successfully claimed.
 */
export async function claimInstallState(nonce) {
  return claimInstallNonce(nonce);
}

function parseRepo(repo) {
  const [owner, name] = String(repo || "").split("/");
  if (!owner || !name) throw new Error("GitHub repo must be in owner/name format");
  return { owner, name };
}

/**
 * List repositories selected for a GitHub App installation.
 *
 * @param {string|number} installationId
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<string[]>} Repository names in `owner/name` format.
 */
export async function getInstallationRepos(installationId, options = {}) {
  const token = await getInstallationToken(installationId, options);
  const fetchImpl = options.fetchImpl || fetch;
  const repos = [];
  let page = 1;
  while (page <= 10) {
    const data = await githubFetch(`/installation/repositories?per_page=100&page=${page}`, {
      token,
      fetchImpl,
    });
    const batch = Array.isArray(data?.repositories) ? data.repositories : [];
    repos.push(...batch.map((repo) => repo.full_name).filter(Boolean));
    if (batch.length < 100) break;
    page++;
  }
  return repos;
}

/**
 * List file paths changed by a pull request using the GitHub PR Files API.
 *
 * @param {Object} args
 * @param {string} args.repo
 * @param {number|string} args.prNumber
 * @param {string|number} args.installationId
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<string[]>}
 */
export async function getChangedFilesForPr({ repo, prNumber, installationId }, options = {}) {
  const { owner, name } = parseRepo(repo);
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) throw new Error("GitHub prNumber must be a positive integer");
  const token = await getInstallationToken(installationId, options);
  const fetchImpl = options.fetchImpl || fetch;
  const files = [];
  let page = 1;
  while (page <= 10) {
    const data = await githubFetch(`/repos/${owner}/${name}/pulls/${n}/files?per_page=100&page=${page}`, {
      token,
      fetchImpl,
    });
    const batch = Array.isArray(data) ? data : [];
    files.push(...batch.map((f) => f?.filename).filter(Boolean));
    if (batch.length < 100) break;
    page++;
  }
  return [...new Set(files)];
}

/**
 * AUTO-009d — List changed line ranges per file from a pull request, parsed
 * directly from the GitHub PR Files API `patch` field. Returns the diff hunks
 * as inclusive `[start, end]` ranges of LINE NUMBERS IN THE HEAD VERSION of
 * each file (the version that's actually on disk in CI) so the coverage
 * aggregator can ask "of the lines this PR added/modified, which are covered
 * by the test run?"
 *
 * ### Hunk header parse
 * GitHub returns unified-diff hunk headers like `@@ -10,7 +20,12 @@`:
 *   - `-10,7`  → source side: 7 lines starting at line 10
 *   - `+20,12` → head   side: 12 lines starting at line 20
 *
 * We only care about the `+side` (head) range — that's the line numbers a
 * developer sees in their IDE and what `coverageSummary.topUncoveredFiles[]`
 * line numbers will match against post-source-map resolution (AUTO-009b).
 *
 * ### Removed lines / deletions
 * Hunks that are purely deletions (no `+` lines in the body) still appear in
 * the patch but contribute zero lines to the head version. We skip them via
 * the `headCount > 0` guard — there's nothing to demand coverage for.
 *
 * ### Renames / binary files
 * GitHub omits the `patch` field entirely for:
 *   - Binary files (PNG, ZIP, …) — no diff to parse.
 *   - Renames where `status === "renamed"` AND no content changed.
 *   - Files past the 3000-line / 1MB patch-size cap (GitHub API limit).
 * Each of those skips the file (no entry in the returned map). The coverage
 * gate degrades gracefully — coverage-of-changed-lines is undefined for an
 * unparseable file, which is the honest signal.
 *
 * ### Bounded pagination
 * Same 10-page cap as `getChangedFilesForPr` so a giant PR can't unbounded-
 * fetch. Files past page 10 are silently dropped; the gate evaluator
 * already accepts partial data (covered ≤ total, gate fires on partial
 * coverage just like full coverage).
 *
 * @param {Object} args
 * @param {string} args.repo            - `owner/name`.
 * @param {number|string} args.prNumber - PR number (must be a positive integer).
 * @param {string|number} args.installationId
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<Object>} `{ [filename]: Array<[startLine, endLine]> }`
 *   where ranges are inclusive head-side line numbers. Files with no
 *   parseable patch are omitted entirely.
 */
export async function getChangedFileRangesForPr({ repo, prNumber, installationId }, options = {}) {
  const { owner, name } = parseRepo(repo);
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) throw new Error("GitHub prNumber must be a positive integer");
  const token = await getInstallationToken(installationId, options);
  const fetchImpl = options.fetchImpl || fetch;
  // GitHub's `patch` field contains zero or more unified-diff hunks. The
  // header regex extracts the `+side` (head) start + count — both groups
  // are decimal integers; `count` defaults to 1 when omitted (single-line
  // hunk shorthand, e.g. `@@ -10 +20 @@`).
  const hunkHeaderRe = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
  /** @type {Object<string, Array<[number, number]>>} */
  const rangesByFile = {};
  let page = 1;
  while (page <= 10) {
    const data = await githubFetch(`/repos/${owner}/${name}/pulls/${n}/files?per_page=100&page=${page}`, {
      token,
      fetchImpl,
    });
    const batch = Array.isArray(data) ? data : [];
    for (const f of batch) {
      const filename = f?.filename;
      const patch = typeof f?.patch === "string" ? f.patch : null;
      if (!filename || !patch) continue;
      const ranges = [];
      hunkHeaderRe.lastIndex = 0;
      let match;
      while ((match = hunkHeaderRe.exec(patch)) !== null) {
        const headStart = Number(match[1]);
        const headCount = match[2] != null ? Number(match[2]) : 1;
        if (!Number.isFinite(headStart) || !Number.isFinite(headCount) || headCount <= 0) continue;
        // Inclusive end = start + count - 1. count===1 yields [N, N] (single
        // line); count===0 hunks (pure deletion) are filtered above.
        ranges.push([headStart, headStart + headCount - 1]);
      }
      if (ranges.length === 0) continue;
      // A renamed file may appear twice across batches (once per page edge);
      // dedupe + concat to preserve order while staying idempotent.
      if (!rangesByFile[filename]) rangesByFile[filename] = [];
      rangesByFile[filename].push(...ranges);
    }
    if (batch.length < 100) break;
    page++;
  }
  return rangesByFile;
}

/**
 * Create a queued GitHub Check Run.
 *
 * @param {string} runId
 * @param {Object} args
 * @param {string} args.repo
 * @param {string} args.sha
 * @param {string|number} args.installationId
 * @param {Object} [options]
 * @returns {Promise<Object>} GitHub check-run payload.
 */
export async function createPending(runId, { repo, sha, installationId }, options = {}) {
  const { owner, name } = parseRepo(repo);
  const token = await getInstallationToken(installationId, options);
  return githubFetch(`/repos/${owner}/${name}/check-runs`, {
    method: "POST",
    token,
    fetchImpl: options.fetchImpl || fetch,
    body: {
      name: CHECK_NAME,
      head_sha: sha,
      status: "queued",
      external_id: runId,
      details_url: buildRunUrl(runId),
    },
  });
}

/**
 * Mark an existing GitHub Check Run in progress.
 *
 * @param {string|number} checkRunId
 * @param {Object} args
 * @param {string} args.repo
 * @param {string|number} args.installationId
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function markInProgress(checkRunId, { repo, installationId }, options = {}) {
  const { owner, name } = parseRepo(repo);
  const token = await getInstallationToken(installationId, options);
  return githubFetch(`/repos/${owner}/${name}/check-runs/${encodeURIComponent(checkRunId)}`, {
    method: "PATCH",
    token,
    fetchImpl: options.fetchImpl || fetch,
    body: { status: "in_progress", started_at: new Date().toISOString() },
  });
}

/**
 * Conclude an existing GitHub Check Run.
 *
 * @param {string|number} checkRunId
 * @param {Object} args
 * @param {string} args.repo
 * @param {string|number} args.installationId
 * @param {"success"|"failure"|"neutral"} args.conclusion
 * @param {string} args.summaryMd
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function conclude(checkRunId, { repo, installationId, conclusion, summaryMd }, options = {}) {
  const { owner, name } = parseRepo(repo);
  const token = await getInstallationToken(installationId, options);
  return githubFetch(`/repos/${owner}/${name}/check-runs/${encodeURIComponent(checkRunId)}`, {
    method: "PATCH",
    token,
    fetchImpl: options.fetchImpl || fetch,
    body: {
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: { title: "Sentri QA results", summary: summaryMd || "Sentri run completed." },
    },
  });
}

/**
 * Build an absolute Run Detail URL for GitHub's details link.
 *
 * @param {string} runId
 * @returns {string|undefined}
 */
export function buildRunUrl(runId) {
  const base = process.env.APP_URL || process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || "";
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/runs/${encodeURIComponent(runId)}`;
}
