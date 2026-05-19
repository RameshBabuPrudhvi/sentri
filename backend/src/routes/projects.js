/**
 * @module routes/projects
 * @description Project CRUD routes. Mounted at `/api/v1/projects` (INF-005).
 *
 * ### Endpoints
 * | Method   | Path                              | Description                                            |
 * |----------|-----------------------------------|--------------------------------------------------------|
 * | `POST`   | `/api/v1/projects`                | Create a project                                       |
 * | `GET`    | `/api/v1/projects`                | List all non-deleted projects                          |
 * | `GET`    | `/api/v1/projects/:id`            | Get a single project                                   |
 * | `PATCH`  | `/api/v1/projects/:id`            | Update project name / URL / credentials                |
 * | `DELETE` | `/api/v1/projects/:id`            | Soft-delete project + cascade soft-delete its data     |
 * | `GET`    | `/api/v1/projects/:id/schedule`   | Get the cron schedule for a project                    |
 * | `PATCH`  | `/api/v1/projects/:id/schedule`   | Create or update the cron schedule for a project       |
 * | `DELETE` | `/api/v1/projects/:id/schedule`   | Remove the cron schedule for a project                 |
 * | `GET`    | `/api/v1/projects/:id/notifications` | Get notification settings for a project             |
 * | `PATCH`  | `/api/v1/projects/:id/notifications` | Create or update notification settings              |
 * | `DELETE` | `/api/v1/projects/:id/notifications` | Remove notification settings for a project          |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import * as scheduleRepo from "../database/repositories/scheduleRepo.js";
import * as elementBaselineRepo from "../database/repositories/elementBaselineRepo.js";
import * as visionBudgetRepo from "../database/repositories/visionBudgetRepo.js";
import { getDatabase } from "../database/sqlite.js";
import { generateProjectId, generateScheduleId } from "../utils/idGenerator.js";
import * as environmentRepo from "../database/repositories/environmentRepo.js";
import { logActivity } from "../utils/activityLogger.js";
import { encryptCredentials, decryptCredentials } from "../utils/credentialEncryption.js";
import { validateProjectPayload, sanitise } from "../utils/validate.js";
import { randomUUID } from "node:crypto";
import { actor } from "../utils/actor.js";
import { sanitiseProjectForClient, sanitiseEnvCredentialsForClient } from "../utils/projectSanitiser.js";
import { reloadSchedule, stopSchedule, getNextRunAt } from "../scheduler.js";
import { requireRole } from "../middleware/requireRole.js";
import * as notificationSettingsRepo from "../database/repositories/notificationSettingsRepo.js";
import * as metricSamplesRepo from "../database/repositories/metricSamplesRepo.js";
import { generateNotificationSettingId } from "../utils/idGenerator.js";
import { validateUrl } from "../utils/ssrfGuard.js";
import { hasVisionProvider } from "../aiProvider.js";
import cron from "node-cron";

const router = Router();


function validateQualityGates(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "qualityGates must be an object";
  const gates = {};
  if (payload.minPassRate != null) {
    if (!Number.isFinite(payload.minPassRate) || payload.minPassRate < 0 || payload.minPassRate > 100) return "minPassRate must be between 0 and 100";
    gates.minPassRate = payload.minPassRate;
  }
  if (payload.maxFlakyPct != null) {
    if (!Number.isFinite(payload.maxFlakyPct) || payload.maxFlakyPct < 0 || payload.maxFlakyPct > 100) return "maxFlakyPct must be between 0 and 100";
    gates.maxFlakyPct = payload.maxFlakyPct;
  }
  if (payload.maxFailures != null) {
    if (!Number.isInteger(payload.maxFailures) || payload.maxFailures < 0) return "maxFailures must be a non-negative integer";
    gates.maxFailures = payload.maxFailures;
  }
  // AUTO-009d — coverage gates. All four are expressed as percentages
  // (0–100) so the UI can share the same `<input type="number" min=0 max=100
  // step=1>` primitive as `minPassRate` / `maxFlakyPct`. The evaluator
  // compares against `coveragePct` / `branchPct` (which are stored as 0–1
  // ratios on `run.coverageSummary`) by multiplying by 100 once at
  // comparison time — keeps the wire format human-readable and avoids
  // a footgun where a user types `0.7` expecting "70%" and gets "0.7%".
  if (payload.minCoveragePct != null) {
    if (!Number.isFinite(payload.minCoveragePct) || payload.minCoveragePct < 0 || payload.minCoveragePct > 100) {
      return "minCoveragePct must be between 0 and 100";
    }
    gates.minCoveragePct = payload.minCoveragePct;
  }
  if (payload.minBranchPct != null) {
    if (!Number.isFinite(payload.minBranchPct) || payload.minBranchPct < 0 || payload.minBranchPct > 100) {
      return "minBranchPct must be between 0 and 100";
    }
    gates.minBranchPct = payload.minBranchPct;
  }
  if (payload.minPrCoveragePct != null) {
    if (!Number.isFinite(payload.minPrCoveragePct) || payload.minPrCoveragePct < 0 || payload.minPrCoveragePct > 100) {
      return "minPrCoveragePct must be between 0 and 100";
    }
    gates.minPrCoveragePct = payload.minPrCoveragePct;
  }
  if (payload.maxCoverageRegressionPct != null) {
    if (!Number.isFinite(payload.maxCoverageRegressionPct) || payload.maxCoverageRegressionPct < 0 || payload.maxCoverageRegressionPct > 100) {
      return "maxCoverageRegressionPct must be between 0 and 100";
    }
    gates.maxCoverageRegressionPct = payload.maxCoverageRegressionPct;
  }
  // Reject empty payloads — without at least one gate field, the stored
  // `{}` would render as "Active" in the UI and cause the evaluator to
  // return `{ passed: true }` for every run despite no thresholds being
  // configured. Clients clearing all gates should use DELETE instead.
  if (Object.keys(gates).length === 0) {
    return "qualityGates must contain at least one gate field (minPassRate, maxFlakyPct, maxFailures, minCoveragePct, minBranchPct, minPrCoveragePct, maxCoverageRegressionPct)";
  }
  return gates;
}


function validateWebVitalsBudgets(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "webVitalsBudgets must be an object";
  const out = {};
  for (const key of ["lcp", "cls", "inp", "ttfb"]) {
    if (payload[key] != null) {
      if (!Number.isFinite(payload[key]) || payload[key] < 0) return `${key} must be a non-negative number`;
      out[key] = payload[key];
    }
  }
  if (Object.keys(out).length === 0) return "webVitalsBudgets must include at least one of: lcp, cls, inp, ttfb";
  return out;
}


// ─── Project CRUD ─────────────────────────────────────────────────────────────


router.get("/:id/environments", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  // REVIEW.md security checklist: never ship plaintext passwords over the
  // wire. Decrypt to read username for display, then funnel through
  // sanitiseEnvCredentialsForClient → { username, _hasAuth: true } only.
  const rows = environmentRepo.listByProject(project.id).map((row) => ({
    ...row,
    credentials: sanitiseEnvCredentialsForClient(decryptCredentials(row.credentials)),
  }));
  res.json(rows);
});

router.post("/:id/environments", requireRole("admin"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const name = sanitise(req.body?.name, 120);
  const baseUrl = req.body?.baseUrl?.trim();
  if (!name || !baseUrl) return res.status(400).json({ error: "name and baseUrl are required" });
  // SSRF-safe URL validation — `environment.baseUrl` is used as the crawl
  // target on any run that picks this env (`envScopedProject` in
  // `utils/envScope.js`), so an admin who pastes `http://169.254.169.254`
  // or `http://localhost:6379` here could point the Playwright crawler at
  // cloud-metadata / RFC1918 / loopback hosts. Same two-layer guard used
  // for `previewUrl` on the webhook path (`routes/trigger.js`) and the
  // notification webhooks below.
  const urlErr = await validateUrl(baseUrl);
  if (urlErr) return res.status(400).json({ error: `baseUrl: ${urlErr}` });
  const id = `ENV-${randomUUID()}`;
  const row = { id, projectId: project.id, name, baseUrl, credentials: encryptCredentials(req.body?.credentials) || null, createdAt: new Date().toISOString(), workspaceId: project.workspaceId || null };
  environmentRepo.create(row);
  // Sanitise on the way out — even on POST, the response must NOT echo the
  // password the caller just sent (REVIEW.md: any password round-trip is a
  // logging/proxy/replay leak surface).
  res.status(201).json({ ...row, credentials: sanitiseEnvCredentialsForClient(decryptCredentials(row.credentials)) });
});

router.patch("/:id/environments/:environmentId", requireRole("admin"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const existing = environmentRepo.getById(req.params.environmentId);
  if (!existing || existing.projectId !== project.id) return res.status(404).json({ error: "not found" });
  const fields = {};
  if (req.body?.name !== undefined) fields.name = sanitise(req.body.name, 120);
  if (req.body?.baseUrl !== undefined) {
    const trimmed = req.body.baseUrl?.trim() || "";
    // SSRF-safe URL validation on PATCH too — see POST handler above for
    // the full rationale. Empty string short-circuits past the validator
    // because `validateUrl("")` would reject before reaching SQLite, but
    // an empty baseUrl is functionally broken regardless: the next run
    // using this env would fall back to undefined behaviour. We let the
    // validator reject empties so the admin sees a clear error.
    const urlErr = await validateUrl(trimmed);
    if (urlErr) return res.status(400).json({ error: `baseUrl: ${urlErr}` });
    fields.baseUrl = trimmed;
  }
  // Credentials handling — three cases:
  //   1. Key absent      → don't touch the stored value (existing behaviour).
  //   2. `credentials: null` → explicit clear.
  //   3. Object payload  → merge: blank `username` / `password` fall back to
  //      the existing stored value. Required because the frontend no longer
  //      echoes the password (it was a REVIEW.md security violation); without
  //      the merge, editing a row to rename it would also wipe the stored
  //      secret because `password: ""` would re-encrypt as empty. Mirrors the
  //      project PATCH path's merge logic at routes/projects.js:243-273.
  if (Object.hasOwn(req.body || {}, 'credentials')) {
    if (req.body.credentials === null) {
      fields.credentials = null;
    } else if (req.body.credentials && typeof req.body.credentials === "object") {
      const incoming = req.body.credentials;
      const existingDecrypted = decryptCredentials(existing.credentials) || {};
      const merged = {
        username: incoming.username || existingDecrypted.username || "",
        password: incoming.password || existingDecrypted.password || "",
      };
      fields.credentials = (merged.username || merged.password) ? encryptCredentials(merged) : null;
    }
  }
  environmentRepo.update(existing.id, fields);
  const updated = environmentRepo.getById(existing.id);
  res.json({ ...updated, credentials: sanitiseEnvCredentialsForClient(decryptCredentials(updated.credentials)) });
});

router.delete("/:id/environments/:environmentId", requireRole("admin"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const existing = environmentRepo.getById(req.params.environmentId);
  if (!existing || existing.projectId !== project.id) return res.status(404).json({ error: "not found" });
  environmentRepo.remove(existing.id);
  res.json({ ok: true });
});


router.post("/", requireRole("qa_lead"), (req, res) => {
  const validationErr = validateProjectPayload(req.body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const name = sanitise(req.body.name, 200);
  const url = req.body.url?.trim() || "";
  const credentials = req.body.credentials;

  const id = generateProjectId();
  const project = {
    id,
    name,
    url,
    credentials: encryptCredentials(credentials) || null,
    createdAt: new Date().toISOString(),
    status: "idle",
    workspaceId: req.workspaceId || null,
  };
  projectRepo.create(project);

  logActivity({ ...actor(req),
    type: "project.create", projectId: id, projectName: name,
    detail: `Project created — "${name}" (${url})`,
  });

  res.status(201).json(sanitiseProjectForClient(project));
});

router.get("/", (req, res) => {
  res.json(projectRepo.getAll(req.workspaceId).map(sanitiseProjectForClient));
});

router.get("/:id", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(sanitiseProjectForClient(project));
});

/**
 * PATCH /api/projects/:id
 * Update a project's name, URL, and/or credentials.
 *
 * Credentials handling:
 *   - `credentials: null` clears stored credentials entirely.
 *   - If `credentials` is an object with blank `username` or `password`,
 *     the existing encrypted value for that field is preserved. This lets
 *     the edit form round-trip without requiring the user to re-type secrets
 *     (which the server never sends back — see `projectSanitiser.js`).
 */
router.patch("/:id", requireRole("qa_lead"), async (req, res) => {
  const existing = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: "not found" });

  // Bypass-eligible PATCHes (from dedicated panels in `ProjectQualityCard.jsx`)
  // skip the name/url validation gate. Each panel sends only its own
  // field(s) — e.g. AutoApprovalPanel sends `{ autoApproveThreshold }`,
  // PiiFirewallPanel sends `{ strictPiiFirewall, piiAllowlist }`,
  // VisionHealingPanel sends `{ visionHealing, visionHealMaxCallsPerDay,
  // visionHealMaxCostUsdPerMonth }`. The bypass requires every key in the
  // body to be in the whitelist, so an attempted `status` / `workspaceId`
  // injection still falls through to the full `validateProjectPayload` +
  // field-whitelist path below.
  const bodyKeys = req.body && typeof req.body === "object" ? Object.keys(req.body) : [];
  const SINGLE_FIELD_BYPASS = new Set(["autoApproveThreshold", "iterationCap", "strictPiiFirewall", "piiAllowlist", "visionHealing", "visionHealMaxCallsPerDay", "visionHealMaxCostUsdPerMonth", "coverageEnabled", "sourcemapBaseUrl", "serverCoverageEndpoint", "coverageRegressionThresholdPct"]);
  const isSingleFieldPatch = bodyKeys.length > 0 && bodyKeys.every((k) => SINGLE_FIELD_BYPASS.has(k));
  if (!isSingleFieldPatch) {
    const validationErr = validateProjectPayload(req.body);
    if (validationErr) return res.status(400).json({ error: validationErr });
  }

  const name = req.body.name !== undefined ? sanitise(req.body.name, 200) : existing.name;
  const url  = req.body.url !== undefined ? (req.body.url?.trim() || "") : existing.url;

  const fields = { name, url };
  if (Object.hasOwn(req.body, "autoApproveThreshold")) {
    const threshold = req.body.autoApproveThreshold;
    // Disallow 0 to prevent a footgun: with `confidenceScore >= 0` always
    // true, threshold=0 would auto-approve every generated test (including
    // zero-quality ones). Use `null` to disable auto-approval.
    if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) {
      return res.status(400).json({ error: "autoApproveThreshold must be null or a number greater than 0 and at most 1." });
    }
    fields.autoApproveThreshold = threshold;
  }

  // CAP-001: per-project fixture iteration cap. `null` clears the column so
  // the server-side default (10) re-applies. Otherwise must be an integer
  // in [1, 100] — the runtime `clampIterationCap` also enforces this range,
  // but rejecting bad input at the API surface gives the user a clear error
  // instead of silently clamping a typo.
  if (Object.hasOwn(req.body, "iterationCap")) {
    const cap = req.body.iterationCap;
    if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 100)) {
      return res.status(400).json({ error: "iterationCap must be null or an integer between 1 and 100." });
    }
    fields.iterationCap = cap;
  }

  // SEC-006: per-project PII firewall toggle. `null` is rejected — the
  // column is `NOT NULL DEFAULT 1`, so clients clear the override by
  // explicitly sending `true` (the default) instead. Only booleans are
  // accepted; the bypass set at the top of this handler already restricts
  // single-field PATCHes to this exact key.
  if (Object.hasOwn(req.body, "strictPiiFirewall")) {
    const v = req.body.strictPiiFirewall;
    if (typeof v !== "boolean") {
      return res.status(400).json({ error: "strictPiiFirewall must be a boolean." });
    }
    fields.strictPiiFirewall = v;
  }

  // SEC-006: per-project PII allowlist. Accepts `null` (clear) or an
  // array of non-empty strings. Bounded length to keep the per-redact
  // Set lookup cheap and to discourage clients from pasting megabytes
  // of "allowed" values into the column.
  if (Object.hasOwn(req.body, "piiAllowlist")) {
    const v = req.body.piiAllowlist;
    if (v === null) {
      fields.piiAllowlist = null;
    } else if (Array.isArray(v) && v.every((s) => typeof s === "string") && v.length <= 200) {
      fields.piiAllowlist = v.map((s) => s.trim()).filter(Boolean);
    } else {
      return res.status(400).json({ error: "piiAllowlist must be null or an array of up to 200 strings." });
    }
  }


  // MNT-001: per-project vision-healing toggle. Validates the mode string
  // and gates `pixelmatch_and_llm` behind a server-side vision-capable
  // provider check (via aiProvider.hasVisionProvider() — more accurate
  // than raw env-var sniffing because it respects runtime key overrides
  // configured in Settings and the model-capability whitelist).
  if (Object.hasOwn(req.body, "visionHealing")) {
    const mode = req.body.visionHealing;
    const allowedModes = new Set(["off", "pixelmatch_only", "pixelmatch_and_llm"]);
    if (!allowedModes.has(mode)) {
      return res.status(400).json({ error: "visionHealing must be one of: off, pixelmatch_only, pixelmatch_and_llm." });
    }
    if (mode === "pixelmatch_and_llm" && !hasVisionProvider()) {
      // Surfaced verbatim by Settings.jsx as a disabled-state tooltip
      // ("VISION_MODEL not configured server-side"). Don't change this
      // error code without updating the frontend consumer.
      return res.status(400).json({ error: "VISION_PROVIDER_NOT_CONFIGURED" });
    }
    fields.visionHealing = mode;
  }

  if (Object.hasOwn(req.body, "visionHealMaxCallsPerDay")) {
    const cap = req.body.visionHealMaxCallsPerDay;
    if (!Number.isInteger(cap) || cap < 1 || cap > 10000) return res.status(400).json({ error: "visionHealMaxCallsPerDay must be an integer between 1 and 10000." });
    fields.visionHealMaxCallsPerDay = cap;
  }

  if (Object.hasOwn(req.body, "visionHealMaxCostUsdPerMonth")) {
    const cap = req.body.visionHealMaxCostUsdPerMonth;
    if (!Number.isFinite(cap) || cap < 0 || cap > 100000) return res.status(400).json({ error: "visionHealMaxCostUsdPerMonth must be a number between 0 and 100000." });
    fields.visionHealMaxCostUsdPerMonth = cap;
  }
  if (Object.hasOwn(req.body, "coverageEnabled")) {
    if (typeof req.body.coverageEnabled !== "boolean") {
      return res.status(400).json({ error: "coverageEnabled must be a boolean." });
    }
    fields.coverageEnabled = req.body.coverageEnabled;
  }
  if (Object.hasOwn(req.body, "sourcemapBaseUrl")) {
    const value = req.body.sourcemapBaseUrl;
    if (value === null || value === "") {
      fields.sourcemapBaseUrl = null;
    } else if (typeof value !== "string") {
      return res.status(400).json({ error: "sourcemapBaseUrl must be a string URL or null." });
    } else {
      const trimmed = value.trim();
      const urlErr = await validateUrl(trimmed);
      if (urlErr) return res.status(400).json({ error: `sourcemapBaseUrl: ${urlErr}` });
      fields.sourcemapBaseUrl = trimmed;
    }
  }

  // AUTO-009h — server-side coverage capture for API tests. Accepts:
  //   - `null` / "" → opt-out (default).
  //   - `http://…` / `https://…` → SSRF-validated snapshot endpoint
  //     (typical c8 / NYC `GET /__coverage__` pattern).
  //   - `file:///…` → shared-FS path (file-watch mode). Skip SSRF (not a
  //     URL the server fetches) but require an absolute path so a relative
  //     `file://./cov.json` doesn't accidentally resolve against the
  //     server's CWD. Documented in `docs/guide/coverage-server-side.md`.
  if (Object.hasOwn(req.body, "serverCoverageEndpoint")) {
    const value = req.body.serverCoverageEndpoint;
    if (value === null || value === "") {
      fields.serverCoverageEndpoint = null;
    } else if (typeof value !== "string") {
      return res.status(400).json({ error: "serverCoverageEndpoint must be a string URL or null." });
    } else {
      const trimmed = value.trim();
      if (trimmed.startsWith("file://")) {
        // File-watch mode. Validate the path is absolute so a typo can't
        // surprise the operator with CWD-relative resolution at run time.
        const path = trimmed.slice("file://".length);
        if (!path.startsWith("/")) {
          return res.status(400).json({ error: "serverCoverageEndpoint: file:// path must be absolute (e.g. file:///var/coverage/coverage.json)." });
        }
        fields.serverCoverageEndpoint = trimmed;
      } else {
        const urlErr = await validateUrl(trimmed);
        if (urlErr) return res.status(400).json({ error: `serverCoverageEndpoint: ${urlErr}` });
        fields.serverCoverageEndpoint = trimmed;
      }
    }
  }

  // AUTO-009i — per-project coverage regression alerting threshold.
  // Accepts null (disable) or a number in (0, 100]. Zero disables because
  // "alert on any drop > 0%" is too noisy; operators who want that should
  // use the quality-gate `maxCoverageRegressionPct: 0` which FAILS the run.
  if (Object.hasOwn(req.body, "coverageRegressionThresholdPct")) {
    const v = req.body.coverageRegressionThresholdPct;
    if (v === null || v === 0) {
      fields.coverageRegressionThresholdPct = null;
    } else if (!Number.isFinite(v) || v < 0 || v > 100) {
      return res.status(400).json({ error: "coverageRegressionThresholdPct must be null, 0 (disable), or a number between 0 and 100." });
    } else {
      fields.coverageRegressionThresholdPct = v;
    }
  }

  if (req.body.credentials === null) {
    fields.credentials = null;
  } else if (req.body.credentials) {
    // Merge: any blank secret falls back to the existing stored value so the
    // client can PATCH without re-sending the password.
    //
    // We normalise `existing.credentials` through `decryptCredentials()` first
    // so legacy unencrypted rows (no `_encrypted` flag, pre-dating the
    // encryption module) and current encrypted rows are both handled
    // uniformly. Then the merged plaintext object is passed through
    // `encryptCredentials()` exactly once — no post-hoc copy of raw stored
    // fields into a `_encrypted: true` object, which would mix plaintext
    // values into an "encrypted" envelope and permanently corrupt the row
    // (next `decryptCredentials()` call throws and returns `null`).
    //
    // Selectors fall back to existing values when the client omits or blanks
    // them, so editing a legacy explicit-selector project doesn't silently
    // wipe its login strategy. The new frontend only sends username +
    // password (selectors are auto-detected at crawl time); without this
    // fallback any project rename/credential rotation would clobber the
    // saved selectors.
    const incoming = req.body.credentials;
    const existingDecrypted = decryptCredentials(existing.credentials) || {};
    const merged = {
      usernameSelector: incoming.usernameSelector ?? existingDecrypted.usernameSelector ?? "",
      passwordSelector: incoming.passwordSelector ?? existingDecrypted.passwordSelector ?? "",
      submitSelector:   incoming.submitSelector   ?? existingDecrypted.submitSelector   ?? "",
      username: incoming.username || existingDecrypted.username || "",
      password: incoming.password || existingDecrypted.password || "",
    };
    fields.credentials = encryptCredentials(merged);
  }

  projectRepo.update(req.params.id, fields);

  logActivity({ ...actor(req),
    type: "project.update", projectId: req.params.id, projectName: name,
    detail: `Project updated — "${name}" (${url})`,
  });

  const updated = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  res.json(sanitiseProjectForClient(updated));
});

router.delete("/:id", requireRole("admin"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });

  // Refuse soft-deletion while async operations are in progress
  const activeRun = runRepo.findActiveByProjectId(req.params.id);
  if (activeRun) {
    return res.status(409).json({
      error: "Cannot delete project while operations are running. Wait for active crawls or test runs to complete.",
    });
  }

  // Check for automation config that will be permanently destroyed (not recoverable
  // via restore) so the response can inform the frontend for a user-facing warning.
  const existingTokens  = webhookTokenRepo.getByProjectId(req.params.id);
  const existingSchedule = scheduleRepo.getByProjectId(req.params.id);

  // Wrap the cascade soft-delete in a transaction so all three tables get the
  // same `datetime('now')` value.  This guarantees the cascade-restore in
  // recycleBin.js (which uses `deletedAt >= project.deletedAt`) never misses
  // children due to a second-boundary crossing between separate statements.
  const db = getDatabase();
  let testIds, runIds;
  db.transaction(() => {
    projectRepo.deleteById(req.params.id);
    testIds = testRepo.deleteByProjectId(req.params.id);
    runIds  = runRepo.deleteByProjectId(req.params.id);
    // Trigger tokens are not soft-deleted — they are always hard-deleted
    // immediately since they are security credentials, not recoverable data.
    // Restoring the project will NOT restore these — CI pipelines will need
    // new tokens.
    webhookTokenRepo.deleteByProjectId(req.params.id);
    // Stop any armed cron task so the scheduler doesn't keep firing for a
    // soft-deleted project (which would log repeated warnings every interval).
    // Restoring the project will NOT restore the schedule — it must be
    // reconfigured manually.
    scheduleRepo.deleteByProjectId(req.params.id);
    // MNT-001 — vision-healing artifacts are not soft-deleted: baseline
    // crop BLOBs (2-10 KB × hundreds of elements per project) and per-
    // window budget counters would otherwise accumulate unbounded after
    // every project deletion. Both repos document this cascade contract
    // explicitly. Restoring the project will NOT restore baselines; the
    // next green run regenerates them via captureElementCrop.
    try { elementBaselineRepo.deleteByProjectId(req.params.id); } catch { /* best-effort */ }
    try { visionBudgetRepo.deleteByProjectId(req.params.id); } catch { /* best-effort */ }
  })();
  stopSchedule(req.params.id);

  logActivity({ ...actor(req),
    type: "project.delete", projectId: req.params.id, projectName: project.name,
    detail: `Project soft-deleted — "${project.name}" (${testIds.length} tests, ${runIds.length} runs moved to recycle bin)`,
  });

  res.json({
    ok: true,
    deletedTests: testIds.length,
    deletedRuns: runIds.length,
    // Inform the client about permanently destroyed automation config so the
    // frontend can display a warning (these are NOT restored on project restore).
    destroyedTokens: existingTokens.length,
    destroyedSchedule: !!existingSchedule,
  });
});


/**
 * GET /api/v1/projects/:id/pages
 * Return URLs discovered on the latest successful crawl (or recorder run)
 * for this project, with the project's seed URL prepended so the dropdown
 * is never empty.
 *
 * Backed by `runRepo.getLatestDiscoveredPageUrls()` so the query is a
 * single `SELECT pages LIMIT 1` instead of `SELECT *` + per-row JSON parse
 * of every run's heavy columns — the dropdown is fetched on every
 * recorder modal open and previously scaled poorly on projects with long
 * run history. We intentionally do NOT filter on `status = 'completed'`:
 * `crawler.js` flips status to `"completed_empty"` when a crawl finishes
 * without generating tests (auth-walled sites, SPAs with no interactive
 * elements, AI-rate-limited runs), but those runs still persist a valid
 * `run.pages` array — filtering them out caused the dropdown to show only
 * the seed URL on any project whose latest crawl didn't yield tests.
 */
router.get("/:id/pages", requireRole("viewer"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const pages = runRepo.getLatestDiscoveredPageUrls(req.params.id);
  const unique = Array.from(new Set([project.url, ...pages].filter(Boolean)));
  res.json({ urls: unique });
});

router.get("/:id/quality-gates", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json({ qualityGates: project.qualityGates || null });
});

router.patch("/:id/quality-gates", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const validated = validateQualityGates(req.body?.qualityGates ?? req.body);
  if (typeof validated === "string") return res.status(400).json({ error: validated });
  projectRepo.update(req.params.id, { qualityGates: validated });
  const updated = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  res.json({ qualityGates: updated.qualityGates || null });
});

router.delete("/:id/quality-gates", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  projectRepo.update(req.params.id, { qualityGates: null });
  res.json({ ok: true, qualityGates: null });
});


router.get("/:id/web-vitals-budgets", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json({ webVitalsBudgets: project.webVitalsBudgets || null });
});

router.patch("/:id/web-vitals-budgets", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const validated = validateWebVitalsBudgets(req.body?.webVitalsBudgets ?? req.body);
  if (typeof validated === "string") return res.status(400).json({ error: validated });
  projectRepo.update(req.params.id, { webVitalsBudgets: validated });
  const updated = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  res.json({ webVitalsBudgets: updated.webVitalsBudgets || null });
});

router.delete("/:id/web-vitals-budgets", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  projectRepo.update(req.params.id, { webVitalsBudgets: null });
  res.json({ ok: true, webVitalsBudgets: null });
});


/**
 * GET /api/v1/projects/:id/metrics?key=<metricKey>&since=<ms>&limit=<n>
 *
 * Read a project's time-series samples for a single metric (MET-001 +
 * AUTO-017.3). Powers the `<TrendChart>` instances in
 * `ProjectQualityCard`'s Web Vitals tab. Workspace-scoped — falls through
 * to the same 404 as every other project route when the caller isn't a
 * member.
 */
router.get("/:id/metrics", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const key = typeof req.query.key === "string" ? req.query.key : "";
  if (!key) return res.status(400).json({ error: "key is required" });
  const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
  const rawLimit = Number(req.query.limit);
  // Cap at 200 to match `getSeries`'s default ceiling — keeps the
  // `<TrendChart>` last-30 window cheap and prevents callers from
  // pulling the whole table.
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 200;
  const samples = metricSamplesRepo.getSeries(req.params.id, key, { since, limit });
  res.json({ samples });
});

// ─── Schedule endpoints ───────────────────────────────────────────────────────

/**
 * GET /api/projects/:id/schedule
 * Return the current schedule for a project, or null if none exists.
 */
router.get("/:id/schedule", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const schedule = scheduleRepo.getByProjectId(req.params.id);
  res.json({ schedule: schedule || null });
});

/**
 * PATCH /api/projects/:id/schedule
 * Create or update the cron schedule for a project.
 *
 * Body:
 *   cronExpr {string}  - 5-field cron expression (required)
 *   timezone {string}  - IANA timezone name (default "UTC")
 *   enabled  {boolean} - Whether the schedule is active (default true)
 */
router.patch("/:id/schedule", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { cronExpr, timezone = "UTC", enabled = true } = req.body || {};

  if (!cronExpr || typeof cronExpr !== "string") {
    return res.status(400).json({ error: "cronExpr is required" });
  }
  if (!cron.validate(cronExpr)) {
    return res.status(400).json({ error: `Invalid cron expression: "${cronExpr}"` });
  }
  // Reject expressions with seconds field (6-part) — node-cron supports it
  // but we only expose the standard 5-field format to users.
  if (cronExpr.trim().split(/\s+/).length !== 5) {
    return res.status(400).json({ error: "cronExpr must be a standard 5-field expression (minute hour dom month dow)" });
  }

  // Validate timezone — an invalid IANA name would throw a RangeError in
  // toLocaleString (used by getNextRunAt) and crash with a 500.
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    return res.status(400).json({ error: `Invalid timezone: "${timezone}"` });
  }

  const existing = scheduleRepo.getByProjectId(req.params.id);
  const now = new Date().toISOString();
  const nextRunAt = getNextRunAt(cronExpr, timezone);

  const schedule = scheduleRepo.upsert({
    id: existing?.id || generateScheduleId(),
    projectId: req.params.id,
    cronExpr,
    timezone,
    enabled: Boolean(enabled),
    lastRunAt: existing?.lastRunAt || null,
    nextRunAt,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });

  // Hot-reload the cron task without a restart
  reloadSchedule(req.params.id);

  logActivity({
    ...actor(req),
    type: "schedule.update",
    projectId: project.id,
    projectName: project.name,
    detail: `Schedule ${existing ? "updated" : "created"} — ${cronExpr} (${timezone})`,
  });

  res.json({ ok: true, schedule });
});

/**
 * DELETE /api/projects/:id/schedule
 * Remove the cron schedule for a project entirely.
 */
router.delete("/:id/schedule", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const existing = scheduleRepo.getByProjectId(req.params.id);
  if (!existing) return res.status(404).json({ error: "No schedule found for this project" });

  scheduleRepo.deleteByProjectId(req.params.id);
  stopSchedule(req.params.id);

  logActivity({
    ...actor(req),
    type: "schedule.delete",
    projectId: project.id,
    projectName: project.name,
    detail: `Schedule removed`,
  });

  res.json({ ok: true });
});

// ─── Notification settings endpoints (FEA-001) ───────────────────────────────

/**
 * GET /api/projects/:id/notifications
 * Return the notification settings for a project, or null if none exist.
 */
router.get("/:id/notifications", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const settings = notificationSettingsRepo.getByProjectId(req.params.id);
  res.json({ notifications: settings || null });
});

/**
 * PATCH /api/projects/:id/notifications
 * Create or update notification settings for a project.
 *
 * Body:
 *   teamsWebhookUrl  {string}  - Microsoft Teams incoming webhook URL (optional)
 *   emailRecipients  {string}  - Comma-separated email addresses (optional)
 *   webhookUrl       {string}  - Generic webhook URL (optional)
 *   enabled          {boolean} - Whether notifications are active (default true)
 */
router.patch("/:id/notifications", requireRole("qa_lead"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const { teamsWebhookUrl, emailRecipients, webhookUrl, enabled = true } = req.body || {};

  // Validate at least one channel is configured
  const hasTeams = typeof teamsWebhookUrl === "string" && teamsWebhookUrl.trim();
  const hasEmail = typeof emailRecipients === "string" && emailRecipients.trim();
  const hasWebhook = typeof webhookUrl === "string" && webhookUrl.trim();

  if (!hasTeams && !hasEmail && !hasWebhook) {
    return res.status(400).json({ error: "At least one notification channel must be configured (teamsWebhookUrl, emailRecipients, or webhookUrl)" });
  }

  // SSRF-safe URL validation for webhook URLs (protocol, private hosts, DNS resolution)
  if (hasTeams) {
    const teamsErr = await validateUrl(teamsWebhookUrl);
    if (teamsErr) return res.status(400).json({ error: `teamsWebhookUrl: ${teamsErr}` });
  }
  if (hasWebhook) {
    const webhookErr = await validateUrl(webhookUrl);
    if (webhookErr) return res.status(400).json({ error: `webhookUrl: ${webhookErr}` });
  }

  // Validate email format (basic check)
  if (hasEmail) {
    const emails = emailRecipients.split(",").map(e => e.trim()).filter(Boolean);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of emails) {
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: `Invalid email address: "${email}"` });
      }
    }
  }

  const existing = notificationSettingsRepo.getByProjectId(req.params.id);
  const now = new Date().toISOString();

  const settings = notificationSettingsRepo.upsert({
    id: existing?.id || generateNotificationSettingId(),
    projectId: req.params.id,
    teamsWebhookUrl: hasTeams ? teamsWebhookUrl.trim() : null,
    emailRecipients: hasEmail ? emailRecipients.trim() : null,
    webhookUrl: hasWebhook ? webhookUrl.trim() : null,
    enabled: Boolean(enabled),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });

  logActivity({
    ...actor(req),
    type: "notifications.update",
    projectId: project.id,
    projectName: project.name,
    detail: `Notification settings ${existing ? "updated" : "created"}`,
  });

  res.json({ ok: true, notifications: settings });
});

/**
 * DELETE /api/projects/:id/notifications
 * Remove notification settings for a project.
 */
router.delete("/:id/notifications", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const existing = notificationSettingsRepo.getByProjectId(req.params.id);
  if (!existing) return res.status(404).json({ error: "No notification settings found for this project" });

  notificationSettingsRepo.deleteByProjectId(req.params.id);

  logActivity({
    ...actor(req),
    type: "notifications.delete",
    projectId: project.id,
    projectName: project.name,
    detail: "Notification settings removed",
  });

  res.json({ ok: true });
});

export default router;
