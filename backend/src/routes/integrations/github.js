/**
 * @module routes/integrations/github
 * @description GitHub App installation callback and App-level webhook routes.
 */

import { Router } from "express";
import { requireAuth } from "../auth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { workspaceScope } from "../../middleware/workspaceScope.js";
// requireAuth/workspaceScope/requireRole are applied to `/install/start` only;
// `/install/callback` is authenticated by the signed state JWT (see note below),
// and `/app-webhook` is authenticated by GitHub's HMAC signature.
import { logActivity } from "../../utils/activityLogger.js";
import * as projectRepo from "../../database/repositories/projectRepo.js";
import * as githubCheckSettingsRepo from "../../database/repositories/githubCheckSettingsRepo.js";
import {
  claimInstallState,
  getInstallationRepos,
  signInstallState,
  verifyInstallState,
} from "../../integrations/githubChecks.js";
import { verifyWebhookSignature } from "../trigger.js";

const router = Router();
const INSTALL_ACTIONS = new Set(["install", "update"]);
const LOG_ONLY_EVENTS = new Set(["installation.created", "installation.suspend", "installation.unsuspend"]);

function wantsJson(req) {
  return req.get("accept")?.includes("application/json");
}

function frontendSettingsUrl(params = {}) {
  const base = process.env.APP_URL || process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || "/";
  // Respect `APP_BASE_PATH` for non-root deployments (e.g. `/sentri` for
  // GitHub Pages hosting). Mirrors the pattern in `utils/notifications.js`,
  // `utils/emailSender.js`, and `routes/auth.js`.
  const basePath = (process.env.APP_BASE_PATH || "/").replace(/\/$/, "");
  const url = new URL(base, "http://sentri.local");
  url.pathname = `${basePath}/settings`;
  url.search = new URLSearchParams({ tab: "integrations", ...params }).toString();
  if (base.startsWith("/")) return `${url.pathname}${url.search}`;
  return url.toString();
}

function githubInstallUrl(state) {
  const slug = process.env.GITHUB_APP_SLUG || process.env.GITHUB_APP_NAME;
  if (!slug) return null;
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  url.searchParams.set("state", state);
  // `setup_url` is a soft override for multi-tenant / preview-env deployments
  // whose App registration's static Setup URL points elsewhere. GitHub's
  // documented post-install redirect is the App's registered Setup URL; this
  // param is harmless if ignored and useful when the deployment needs the
  // callback to land on this exact origin (staging vs prod). `state` carries
  // the project binding either way, so security is unaffected.
  const apiBase = (process.env.API_BASE_URL || process.env.APP_URL || process.env.PUBLIC_API_URL || "").replace(/\/$/, "");
  if (apiBase) url.searchParams.set("setup_url", `${apiBase}/api/v1/integrations/github/install/callback`);
  return url.toString();
}

function installationIdFromPayload(body) {
  return body?.installation?.id ? String(body.installation.id) : "";
}

function logProjectActivity(projectId, type, detail, meta = {}) {
  const project = projectRepo.getByIdIncludeDeleted(projectId);
  logActivity({
    type,
    projectId,
    projectName: project?.name || null,
    workspaceId: project?.workspaceId || null,
    detail,
    meta,
  });
}

function logInstallationEvent(installationId, type, detail, meta = {}) {
  const rows = githubCheckSettingsRepo.getByInstallationId(installationId);
  for (const row of rows) logProjectActivity(row.projectId, type, detail, { installationId, ...meta });
}

router.get("/install/start/:projectId", requireAuth, workspaceScope, requireRole("admin"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  // Embed the authenticated admin's identity in the state JWT so the callback
  // — which runs unauthenticated, see below — can still attribute the
  // activity log entry.
  const state = await signInstallState(project.id, {
    actor: { userId: req.authUser?.sub, userName: req.authUser?.name || req.authUser?.email },
  });
  const url = githubInstallUrl(state);
  if (!url) return res.status(503).json({ error: "GITHUB_APP_SLUG is required to start installation" });
  res.json({ url });
});

// NOTE: this callback INTENTIONALLY does NOT use `requireAuth` / `workspaceScope`.
// GitHub redirects the browser back from `github.com`, which is a cross-site
// navigation. In same-origin Sentri deployments the auth cookie uses
// `SameSite=Strict` (see `middleware/appSetup.js`) — browsers refuse to send
// `Strict` cookies on cross-site navigations, so `requireAuth` would 401
// every install. The signed one-shot state JWT is the auth here: it's
// nonce-tracked (replay-proof), signed with JWT_SECRET (unforgeable), and
// binds a specific project + originating admin captured at `/install/start`.
router.get("/install/callback", async (req, res) => {
  const installationId = req.query.installation_id ? String(req.query.installation_id).trim() : "";
  const setupAction = req.query.setup_action ? String(req.query.setup_action) : "";
  const state = req.query.state ? String(req.query.state) : "";
  if (!installationId || !state) return res.status(400).json({ error: "installation_id and state are required" });
  if (setupAction && !INSTALL_ACTIONS.has(setupAction)) return res.status(400).json({ error: "unsupported setup_action" });

  // Verify the state JWT WITHOUT consuming the nonce — we still need to make
  // a fallible GitHub API call (`getInstallationRepos`) before committing.
  // If that call fails (transient 5xx after retries, network timeout, …) the
  // nonce remains intact so the user can refresh and retry rather than being
  // forced to restart the entire install flow from Settings.
  const verified = await verifyInstallState(state, { claim: false });
  if (!verified) return res.status(400).json({ error: "invalid or expired install state" });

  // Workspace scoping is implicit: the state JWT was issued only after an
  // authenticated admin passed `getByIdInWorkspace` in `/install/start`,
  // so `verified.projectId` is already bound to a workspace the initiating
  // admin can administer. Plain `getById` is sufficient here.
  const project = projectRepo.getById(verified.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  let repos;
  try {
    repos = await getInstallationRepos(installationId);
  } catch (err) {
    // GitHub API failed (transient 5xx, rate-limit, network). Leave the
    // nonce intact so a refresh of this callback URL can retry cleanly.
    const message = err?.message || "Failed to fetch installation repositories";
    if (wantsJson(req)) return res.status(502).json({ error: message });
    return res.redirect(302, frontendSettingsUrl({ github: "error", reason: "github_api_failed", projectId: project.id }));
  }
  const repo = repos[0] || "";
  if (!repo) {
    // No repos selected — the install completed but the user didn't grant
    // access to any repository. Consume the nonce (this isn't retryable
    // without re-running the GitHub install flow) and surface the error.
    await claimInstallState(verified.nonce);
    if (wantsJson(req)) return res.status(400).json({ error: "No repositories were selected for this GitHub App installation" });
    return res.redirect(302, frontendSettingsUrl({ github: "error", reason: "no_repos", projectId: project.id }));
  }

  // Fallible work succeeded — claim the nonce so the state JWT is now
  // one-shot. If the claim itself fails (another concurrent callback won
  // the race) bail out without writing settings.
  if (!await claimInstallState(verified.nonce)) {
    return res.status(400).json({ error: "invalid or expired install state" });
  }

  const existing = githubCheckSettingsRepo.getByProjectId(project.id);
  const now = new Date().toISOString();
  const settings = githubCheckSettingsRepo.upsert({
    projectId: project.id,
    enabled: true,
    installationId,
    repo,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  logActivity({
    type: "integration.github.install",
    projectId: project.id,
    projectName: project.name,
    workspaceId: project.workspaceId,
    userId: verified.actorId || undefined,
    userName: verified.actorName || undefined,
    detail: `GitHub App installed for ${repo}`,
    meta: { installationId, repo, setupAction: setupAction || null },
  });

  if (wantsJson(req)) return res.json({ ok: true, settings, repos });
  return res.redirect(302, frontendSettingsUrl({ github: "installed", projectId: project.id }));
});

router.post("/app-webhook", (req, res) => {
  const sig = req.get("X-Hub-Signature-256");
  if (!verifyWebhookSignature("github", req.rawBody, sig)) return res.status(401).json({ error: "invalid signature" });

  const event = req.get("X-GitHub-Event") || "";
  const action = typeof req.body?.action === "string" ? req.body.action : "";
  const eventKey = action ? `${event}.${action}` : event;
  const installationId = installationIdFromPayload(req.body);
  if (!installationId) return res.status(200).json({ ok: true, ignored: true, reason: "missing installation" });

  if (eventKey === "installation.deleted") {
    const projectIds = githubCheckSettingsRepo.disableByInstallationId(installationId);
    for (const projectId of projectIds) {
      logProjectActivity(projectId, "integration.github.disabled", "GitHub App uninstalled; PR checks disabled", { installationId });
    }
    return res.json({ ok: true, disabledProjectIds: projectIds });
  }

  if (eventKey === "installation_repositories.removed") {
    const disabled = [];
    const repos = Array.isArray(req.body?.repositories_removed) ? req.body.repositories_removed : [];
    for (const repoPayload of repos) {
      const repo = repoPayload?.full_name;
      if (!repo) continue;
      const projectIds = githubCheckSettingsRepo.disableByRepo(installationId, repo);
      for (const projectId of projectIds) {
        logProjectActivity(
          projectId,
          "integration.github.disabled",
          `GitHub App repository access removed for ${repo}`,
          { installationId, repo },
        );
      }
      disabled.push(...projectIds.map((projectId) => ({ projectId, repo })));
    }
    return res.json({ ok: true, disabled });
  }

  if (LOG_ONLY_EVENTS.has(eventKey)) {
    logInstallationEvent(installationId, `integration.github.${action}`, `GitHub App ${action} event received`, { event });
    return res.json({ ok: true, ignored: true, event, action });
  }

  return res.json({ ok: true, ignored: true, event, action });
});

export default router;
