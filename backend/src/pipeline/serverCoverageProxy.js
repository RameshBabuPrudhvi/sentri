/**
 * @module pipeline/serverCoverageProxy
 * @description AUTO-009h — Server-side coverage capture for API tests.
 *
 * Sentri runs API tests via Playwright's `request.newContext()` — no
 * browser, so `page.coverage.startJSCoverage()` captures nothing. This
 * module fills the gap by snapshotting the SUT's Istanbul / NYC coverage
 * object **before and after** each API test, then diffing the two so the
 * persisted `result.serverCoverage` represents exactly the server lines
 * the test exercised.
 *
 * ### Modes
 *
 * - **HTTP endpoint** (preferred): the SUT is started with
 *   `c8 --reporter=json` (or `nyc`) and exposes `GET /__coverage__`
 *   returning the live `global.__coverage__` object as JSON. Sentri
 *   `safeFetch`es the endpoint (same SSRF guard that protects every
 *   other outbound URL — see `utils/ssrfGuard.js`).
 * - **File-watch** (`file://…`): the SUT writes its coverage JSON to a
 *   path on a shared filesystem. Sentri reads + parses the file. Useful
 *   for Docker Compose / Kubernetes setups where the SUT runs in a
 *   sidecar container with a shared volume. **No SSRF surface**, but
 *   requires shared storage — operators should consult
 *   `docs/guide/coverage-server-side.md`.
 *
 * ### Threat model
 *
 * Exposing `/__coverage__` leaks the source-file layout of the SUT.
 * Production traffic should NEVER hit a coverage-instrumented build —
 * the guide explicitly recommends gating the endpoint behind a non-prod
 * env var (`NODE_ENV !== "production"`) and an internal-only network
 * ACL. This module enforces only the SSRF boundary; the SUT operator
 * owns the auth / network controls.
 *
 * ### Output shape
 *
 * `diffCoverage(before, after)` returns the Istanbul `FileCoverage`
 * objects that gained covered statements / branches / functions between
 * the two snapshots. The aggregator (`coverageAggregator.js`) ingests
 * the diff alongside browser-side V8 coverage and merges them into one
 * `runs.coverageSummary` with `layer: "server"` on each affected entry.
 *
 * ### Exports
 * - {@link snapshotServerCoverage} — fetch + parse the SUT's coverage.
 * - {@link diffServerCoverage}     — diff two snapshots; returns added
 *   statements / branches / functions per file.
 */

import fs from "node:fs/promises";
import { validateUrl, safeFetch } from "../utils/ssrfGuard.js";
import { formatLogLine } from "../utils/logFormatter.js";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Snapshot the SUT's current Istanbul / NYC coverage object.
 *
 * @param {string} endpoint - `http(s)://…/__coverage__` or `file:///abs/path`.
 * @returns {Promise<Object|null>} The parsed coverage map (`{ [path]: FileCoverage }`),
 *   or `null` on any failure. Best-effort — never throws.
 */
export async function snapshotServerCoverage(endpoint) {
  if (!endpoint || typeof endpoint !== "string") return null;
  try {
    if (endpoint.startsWith("file://")) {
      const path = endpoint.slice("file://".length);
      const body = await fs.readFile(path, "utf-8");
      return JSON.parse(body);
    }
    // SSRF guard — same boundary used by sourcemap resolver, notification
    // webhooks, and the deploy-trigger preview URL. The operator-supplied
    // endpoint is validated at PATCH time but re-checked here to mitigate
    // DNS-rebinding between PATCH and run-time.
    const ssrfErr = await validateUrl(endpoint);
    if (ssrfErr) {
      console.warn(formatLogLine("warn", null, `[serverCoverageProxy] SSRF rejected ${endpoint}: ${ssrfErr}`));
      return null;
    }
    const res = await safeFetch(endpoint, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(formatLogLine("warn", null, `[serverCoverageProxy] ${endpoint} → HTTP ${res.status}`));
      return null;
    }
    const body = await res.text();
    return JSON.parse(body);
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[serverCoverageProxy] ${endpoint}: ${err?.message || err}`));
    return null;
  }
}

/**
 * Diff two Istanbul coverage snapshots. Returns per-file deltas (added
 * statement / branch / function counts) for every file the second
 * snapshot exercised more than the first.
 *
 * Each FileCoverage object carries `s` (statement hit counts), `b`
 * (branch arm hit counts, nested arrays), and `f` (function hit counts).
 * A statement / function / branch arm is "newly covered" iff its `after`
 * count is > 0 AND its `before` count was 0.
 *
 * @param {Object|null} before - Snapshot taken before the API test ran.
 * @param {Object|null} after  - Snapshot taken after the API test ran.
 * @returns {Object} `{ [path]: { addedStatements, addedBranches,
 *   addedFunctions, totalStatements, totalBranches, totalFunctions } }`.
 *   Returns `{}` when either snapshot is null/missing.
 */
export function diffServerCoverage(before, after) {
  if (!after || typeof after !== "object") return {};
  const delta = {};
  const beforeSafe = before && typeof before === "object" ? before : {};
  for (const [path, fileCov] of Object.entries(after)) {
    if (!fileCov || typeof fileCov !== "object") continue;
    const prev = beforeSafe[path] || null;
    let addedStatements = 0;
    let addedBranches = 0;
    let addedFunctions = 0;
    const s = fileCov.s || {};
    const prevS = prev?.s || {};
    for (const id of Object.keys(s)) {
      if ((s[id] || 0) > 0 && (prevS[id] || 0) === 0) addedStatements++;
    }
    const f = fileCov.f || {};
    const prevF = prev?.f || {};
    for (const id of Object.keys(f)) {
      if ((f[id] || 0) > 0 && (prevF[id] || 0) === 0) addedFunctions++;
    }
    const b = fileCov.b || {};
    const prevB = prev?.b || {};
    for (const id of Object.keys(b)) {
      const arms = Array.isArray(b[id]) ? b[id] : [];
      const prevArms = Array.isArray(prevB[id]) ? prevB[id] : [];
      for (let i = 0; i < arms.length; i++) {
        if ((arms[i] || 0) > 0 && (prevArms[i] || 0) === 0) addedBranches++;
      }
    }
    const totalStatements = Object.keys(s).length;
    const totalFunctions = Object.keys(f).length;
    let totalBranches = 0;
    for (const id of Object.keys(b)) {
      const arms = Array.isArray(b[id]) ? b[id] : [];
      totalBranches += arms.length;
    }
    if (addedStatements > 0 || addedBranches > 0 || addedFunctions > 0) {
      delta[path] = {
        addedStatements, addedBranches, addedFunctions,
        totalStatements, totalBranches, totalFunctions,
      };
    }
  }
  return delta;
}
