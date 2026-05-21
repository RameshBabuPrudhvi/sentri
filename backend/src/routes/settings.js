/**
 * @module routes/settings
 * @description Config and Settings routes — AI provider management. Mounted at `/api/v1` (INF-005).
 *
 * ### Endpoints
 * | Method   | Path                          | Description                              |
 * |----------|-------------------------------|------------------------------------------|
 * | `GET`    | `/api/v1/config`              | Active AI provider info for the UI badge |
 * | `GET`    | `/api/v1/settings`            | Masked API key status per provider       |
 * | `POST`   | `/api/v1/settings`            | Save an API key or activate Ollama       |
 * | `DELETE` | `/api/v1/settings/:provider`  | Remove a key or deactivate Ollama        |
 * | `GET`    | `/api/v1/ollama/status`       | Check Ollama connectivity + list models  |
 */

import { Router } from "express";
import { logActivity } from "../utils/activityLogger.js";
import { hasProvider, setRuntimeKey, setRuntimeOllama, setActiveProvider, checkOllamaConnection, getProviderMeta, getConfiguredKeys, getProvider, getSupportedProviders, generateText } from "../aiProvider.js";
import { actor } from "../utils/actor.js";
import { requireRole } from "../middleware/requireRole.js";
import { isDemoEnabled, getDemoQuotaStatus } from "../middleware/demoQuota.js";
import { validateUrl } from "../utils/ssrfGuard.js";
import * as apiKeyRepo from "../database/repositories/apiKeyRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as githubCheckSettingsRepo from "../database/repositories/githubCheckSettingsRepo.js";
import * as agentConfigRepo from "../database/repositories/agentConfigRepo.js";
import { validateAgentConfigs, AGENT_ROLES } from "../aiProvider/agentHealthCheck.js";
import * as providerRouteRepo from "../database/repositories/providerRouteRepo.js";
import * as aiRequestLogRepo from "../database/repositories/aiRequestLogRepo.js";


const router = Router();

// GET /api/config — provider info for the LLM badge shown everywhere
router.get("/config", async (req, res) => {
  const meta = getProviderMeta();
  const response = {
    provider: meta?.provider || null,
    providerName: meta?.name || "No provider configured",
    model: meta?.model || null,
    color: meta?.color || null,
    hasProvider: hasProvider(),
    supportedProviders: getSupportedProviders(),
    // DEMO-MODE: Let the frontend know if the platform demo key is active
    // so it can show quota info and "add your own key" prompts.
    demoMode: isDemoEnabled,
  };
  // Include per-user quota status when in demo mode and user is authenticated
  if (isDemoEnabled && req.authUser?.sub) {
    try {
      response.demoQuota = await getDemoQuotaStatus(req.authUser.sub);
    } catch { /* non-fatal — Redis may be unavailable */ }
  }
  res.json(response);
});

// GET /api/settings — returns masked key status (never full keys)
router.get("/settings", requireRole("admin"), (req, res) => {
  res.json(getConfiguredKeys());
});

// POST /api/settings — save API key at runtime (no server restart needed)
router.post("/settings", requireRole("admin"), async (req, res) => {
  const { provider, apiKey, baseUrl, model } = req.body;
  const validProviders = ["anthropic", "openai", "google", "openrouter", "local"];
  const isCompat = typeof provider === "string" && provider.startsWith("compat:");

  if (!provider || (!validProviders.includes(provider) && !isCompat)) {
    return res.status(400).json({ error: `provider must be one of: ${validProviders.join(", ")}` });
  }

  // ── Quick-switch: frontend sends "__use_existing__" to activate a provider
  // that already has a saved key without re-entering it. Just set the
  // active-provider override — no key is written or validated.
  if (apiKey === "__use_existing__" && provider !== "local") {
    const configured = getConfiguredKeys();
    const hasCompat = isCompat && configured.compatProviders?.some((p) => p.provider === provider);
    if (!configured[provider] && !hasCompat) {
      return res.status(400).json({ error: `No saved key for "${provider}". Add a key in Settings first.` });
    }
    setActiveProvider(provider);
    logActivity({ ...actor(req), type: "settings.update", detail: `Switched active provider to ${getProviderMeta()?.name || provider}` });
    return res.json({
      ok: true,
      provider,
      providerName: getProviderMeta()?.name || provider,
      message: `Switched to ${provider}.`,
    });
  }


  if (isCompat) {
    // Defense-in-depth: the frontend already enforces /^[a-z0-9_-]+$/ on the
    // slot id, but the backend is the trust boundary — re-validate here so
    // direct API callers can't smuggle exotic characters into the DB key
    // (which would also confuse log filters and the compat slot listing).
    const slotId = provider.slice("compat:".length);
    if (!/^[a-z0-9_-]+$/.test(slotId)) {
      return res.status(400).json({ error: "compat slot id must match /^[a-z0-9_-]+$/" });
    }
    const normalizedBaseUrl = (baseUrl || "").trim();
    const normalizedModel = (model || "").trim();
    const normalizedApiKey = (apiKey || "").trim();
    if (!normalizedBaseUrl) return res.status(400).json({ error: "baseUrl is required for compat providers" });
    if (!normalizedModel) return res.status(400).json({ error: "model is required for compat providers" });
    if (!normalizedApiKey || normalizedApiKey.length < 10) return res.status(400).json({ error: "apiKey is required and must be at least 10 characters" });
    // validateUrl is async + returns an error string (or null). Await it
    // and surface the message as a 400 — never let an unvalidated user
    // baseUrl reach the OpenAI SDK (SSRF boundary, NEXT.md AI-001).
    //
    // AI-001: Operator escape hatch for self-hosted / on-prem OpenAI-compatible
    // endpoints (e.g. a local LiteLLM proxy on 127.0.0.1, or an internal vLLM
    // server on 10.0.0.x).  Scoped to compat provider config — does NOT relax
    // SSRF for trigger callbacks, preview URLs, or webhook URLs.
    if (process.env.ALLOW_PRIVATE_URLS === "true") {
      console.warn(`[settings] ALLOW_PRIVATE_URLS=true — bypassing SSRF validation for compat baseUrl ${normalizedBaseUrl}. Do not enable in multi-tenant deployments.`);
    } else {
      const ssrfErr = await validateUrl(normalizedBaseUrl);
      if (ssrfErr) return res.status(400).json({ error: ssrfErr });
    }
    apiKeyRepo.setCompatSlot(provider, { baseUrl: normalizedBaseUrl, model: normalizedModel, apiKey: normalizedApiKey, displayName: (req.body.displayName || provider.replace("compat:", "")).trim() });
    // Reset circuit breaker so updated credentials are retried immediately
    // (consistent with cloud-provider save flow via setRuntimeKey).
    setRuntimeKey(provider, normalizedApiKey);
    setActiveProvider(provider);
    logActivity({ ...actor(req), type: "settings.update", detail: `Compat provider configured: ${provider}` });
    return res.json({ ok: true, provider, providerName: req.body.displayName || provider });
  }
  if (provider === "local") {
    if (baseUrl && baseUrl.trim()) {
      let parsedUrl;
      try { parsedUrl = new URL(baseUrl.trim()); } catch {
        return res.status(400).json({ error: "Invalid Ollama base URL format" });
      }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return res.status(400).json({ error: "Ollama base URL must use http or https protocol" });
      }
      const host = parsedUrl.hostname.replace(/^\[|\]$/g, "");
      const ollamaBlocked =
        host === "169.254.169.254" ||
        host === "metadata.google.internal" ||
        /^fe80:/i.test(host);
      if (ollamaBlocked) {
        return res.status(400).json({ error: "Ollama base URL must not point to cloud metadata or link-local addresses" });
      }
    }
    setRuntimeOllama({ baseUrl: (baseUrl || "").trim(), model: (model || "").trim(), disabled: false });
    setActiveProvider("local");
    logActivity({ ...actor(req), type: "settings.update", detail: "Ollama (local) provider configured" });
    return res.json({
      ok: true,
      provider: "local",
      providerName: getProviderMeta()?.name || "Ollama (local)",
      message: "Local Ollama provider activated. Ensure Ollama is running.",
    });
  }

  if (!apiKey || apiKey.trim().length < 10) {
    return res.status(400).json({ error: "apiKey is required and must be at least 10 characters" });
  }

  setRuntimeKey(provider, apiKey.trim());
  // Pin this provider as the active one after saving a new key
  setActiveProvider(provider);

  logActivity({ ...actor(req),
    type: "settings.update",
    detail: `API key configured for ${getProviderMeta()?.name || provider}`,
  });

  // SEC-007: emit `auth.api_key.create` for the compliance audit log. The
  // `settings.update` row above is the operator-facing activity stream;
  // this companion row is the auth-events stream a SOC-2 reviewer filters
  // on. The raw key is NEVER logged — only the provider and actor.
  logActivity({
    ...actor(req),
    type: "auth.api_key.create",
    req,
    workspaceId: req.workspaceId || null,
    meta: { provider, providerName: getProviderMeta()?.name || provider },
  });

  res.json({
    ok: true,
    provider,
    providerName: getProviderMeta()?.name || provider,
    message: `${provider} API key saved. Provider is now active.`,
  });
});

// DELETE /api/settings/:provider — remove a key or deactivate local provider
router.delete("/settings/:provider", requireRole("admin"), (req, res) => {
  const { provider } = req.params;
  const validProviders = ["anthropic", "openai", "google", "openrouter", "local"];
  const isCompat = typeof provider === "string" && provider.startsWith("compat:");
  if (!validProviders.includes(provider) && !isCompat) {
    return res.status(400).json({ error: `provider must be one of: ${validProviders.join(", ")}` });
  }
  // Defense-in-depth: mirror the POST route's slot-id validation so direct API
  // callers can't smuggle exotic characters through the DELETE path either.
  if (isCompat) {
    const slotId = provider.slice("compat:".length);
    if (!/^[a-z0-9_-]+$/.test(slotId)) {
      return res.status(400).json({ error: "compat slot id must match /^[a-z0-9_-]+$/" });
    }
  }

  // Capture the active provider BEFORE removing the key/config, because
  // getProvider() checks the runtimeActiveProvider override first.
  const wasActive = getProvider();


  if (provider === "local") {
    setRuntimeOllama({ baseUrl: "", model: "", disabled: true });
  } else if (isCompat) {
    apiKeyRepo.deleteCompatSlot(provider);
    // Clear the circuit-breaker entry + sticky fallback so a recreate of the
    // same slot id doesn't inherit stale state, and so repeat create/delete
    // cycles don't accumulate dead entries in the breakers map.
    setRuntimeKey(provider, "");
  } else {
    setRuntimeKey(provider, "");
  }
  // Only clear the active-provider override if it was pointing to the deleted provider
  if (wasActive === provider) setActiveProvider(null);

  logActivity({ ...actor(req),
    type: "settings.update",
    detail: `Provider "${provider}" deactivated`,
  });

  // SEC-007: emit `auth.api_key.revoke` for the compliance audit log so
  // key removal is traceable in the same auth-events stream as creation.
  logActivity({
    ...actor(req),
    type: "auth.api_key.revoke",
    req,
    workspaceId: req.workspaceId || null,
    meta: { provider },
  });

  res.json({ ok: true });
});



// AI-005: AGENT_ROLES is imported from `aiProvider/agentHealthCheck.js` —
// single source of truth shared with the pipeline-side health check and
// (via byte-for-byte mirroring) the frontend Settings dropdown. The
// previous local definition included "executor" (no pipeline stage ever
// used it — dead validator entry) and "default" was wrongly omitted
// here while present in the metrics list, producing two diverging
// allowlists. The canonical 7-role list is now the only source.

// Cap on systemPromptOverride length. Even though this is admin-only, an
// unbounded TEXT column gets serialised on every GET and bloats list
// responses; 32 KB is generous for a system prompt and matches the order of
// magnitude used elsewhere in the codebase for user-supplied free-text.
const MAX_SYSTEM_PROMPT_LEN = 32_000;

function hasFallbackCycle(workspaceId, role, fallbackRole) {
  if (!fallbackRole) return false;
  const byRole = new Map(agentConfigRepo.listByWorkspace(workspaceId).map((r) => [r.role, r.fallbackRole]));
  byRole.set(role, fallbackRole);
  let cur = fallbackRole;
  const seen = new Set([role]);
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = byRole.get(cur) || null;
  }
  return false;
}

router.get("/settings/agent-roles", requireRole("admin"), (req, res) => {
  res.json({ roles: agentConfigRepo.listByWorkspace(req.workspaceId) });
});

router.post("/settings/agent-roles", requireRole("admin"), (req, res) => {
  // B2.1 — `provider` + `model` columns dropped (migration 048). Workspaces
  // now pin dispatch by `routeId` (a `provider_routes` row carries family +
  // model + encrypted key). The route validates `routeId` exists in this
  // workspace via `agentConfigRepo.upsert` (throws `ERR_AGENT_ROUTE_NOT_FOUND`).
  const { role, routeId = null, systemPromptOverride = null, temperature = 0.2, maxTokens = null, fallbackRole = null } = req.body || {};
  if (!AGENT_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  if (fallbackRole && !AGENT_ROLES.includes(fallbackRole)) return res.status(400).json({ error: "Invalid fallbackRole" });
  if (fallbackRole && hasFallbackCycle(req.workspaceId, role, fallbackRole)) return res.status(400).json({ error: "fallbackRole creates a cycle" });
  if (typeof systemPromptOverride === "string" && systemPromptOverride.length > MAX_SYSTEM_PROMPT_LEN) {
    return res.status(400).json({ error: `systemPromptOverride must be ${MAX_SYSTEM_PROMPT_LEN} chars or fewer` });
  }
  const now = new Date().toISOString();
  const existing = agentConfigRepo.getByRole(req.workspaceId, role);
  try {
    const saved = agentConfigRepo.upsert({
      id: existing?.id || `AGC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
      workspaceId: req.workspaceId, role, routeId, systemPromptOverride,
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
      maxTokens: maxTokens == null ? null : (Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : null), fallbackRole,
      createdAt: existing?.createdAt || now, updatedAt: now,
    });
    res.status(existing ? 200 : 201).json(saved);
  } catch (err) {
    if (err?.code === "ERR_AGENT_ROUTE_NOT_FOUND") return res.status(400).json({ error: err.message });
    throw err;
  }
});

// Only these fields are PATCH-able. id/createdAt/role/workspaceId are
// pinned from `existing` so a malicious body can't override the primary
// key or stamp a different workspace onto the row. B2.1 — `provider` and
// `model` were dropped (migration 048); `routeId` is the new dispatch
// pin and replaces both.
const PATCHABLE_AGENT_FIELDS = ["routeId", "systemPromptOverride", "temperature", "maxTokens", "fallbackRole"];

router.patch("/settings/agent-roles/:role", requireRole("admin"), (req, res) => {
  const role = req.params.role;
  if (!AGENT_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  const existing = agentConfigRepo.getByRole(req.workspaceId, role);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const body = req.body || {};
  const payload = { ...existing };
  for (const k of PATCHABLE_AGENT_FIELDS) if (k in body) payload[k] = body[k];
  payload.role = role;
  payload.workspaceId = req.workspaceId;
  if (payload.fallbackRole && !AGENT_ROLES.includes(payload.fallbackRole)) return res.status(400).json({ error: "Invalid fallbackRole" });
  if (payload.fallbackRole && hasFallbackCycle(req.workspaceId, role, payload.fallbackRole)) return res.status(400).json({ error: "fallbackRole creates a cycle" });
  if (typeof payload.systemPromptOverride === "string" && payload.systemPromptOverride.length > MAX_SYSTEM_PROMPT_LEN) {
    return res.status(400).json({ error: `systemPromptOverride must be ${MAX_SYSTEM_PROMPT_LEN} chars or fewer` });
  }
  // Mirror POST's numeric coercion so direct API callers can't smuggle
  // non-numeric strings past SQLite's flexible typing into REAL/INTEGER columns.
  payload.temperature = Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : existing.temperature;
  payload.maxTokens = payload.maxTokens == null ? null : (Number.isFinite(Number(payload.maxTokens)) ? Number(payload.maxTokens) : existing.maxTokens);
  payload.updatedAt = new Date().toISOString();
  try {
    const saved = agentConfigRepo.upsert(payload);
    res.json(saved);
  } catch (err) {
    // B2.1 — surface route-validation failure as a 400 instead of a 500
    // so the Settings UI can render a usable error to the admin.
    if (err?.code === "ERR_AGENT_ROUTE_NOT_FOUND") return res.status(400).json({ error: err.message });
    throw err;
  }
});

router.delete("/settings/agent-roles/:role", requireRole("admin"), (req, res) => {
  const role = req.params.role;
  if (!AGENT_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  agentConfigRepo.remove(req.workspaceId, role);
  res.json({ ok: true });
});

// AI-005 — Settings UI "Test agent" button. Probes a single configured role
// via the same 1-token health-check helper the crawler pre-flight uses, so
// admins can validate a (provider, role) pair end-to-end before a real run
// burns ten minutes against a misconfigured key. Returns the per-role
// `{ ok, reason, provider }` shape carried by `assertAgentConfigsHealthy`'s
// `agentRoles` map. Admin-gated to mirror the rest of the agent-roles surface.
router.post("/settings/agent-roles/:role/test", requireRole("admin"), async (req, res) => {
  const role = req.params.role;
  if (!AGENT_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  const existing = agentConfigRepo.getByRole(req.workspaceId, role);
  if (!existing) return res.status(404).json({ error: "Not found" });
  try {
    const { agentRoles } = await validateAgentConfigs(req.workspaceId, { roles: [role] });
    const status = agentRoles[role] || { ok: false, reason: "no_result", provider: null };
    return res.json({ role, ...status });
  } catch (err) {
    // validateAgentConfigs catches probe errors internally; an exception here
    // means something unexpected (DB outage, etc) — surface it without
    // leaking internals, matching the rest of this router's error contract.
    return res.status(500).json({ role, ok: false, reason: err?.code || "probe_failed", provider: null });
  }
});

// GET /api/settings/github-checks — per-project PR check settings.
router.get("/settings/github-checks", requireRole("qa_lead"), (req, res) => {
  const projects = projectRepo.getAll(req.workspaceId);
  const byProject = new Map(githubCheckSettingsRepo.listByProjectIds(projects.map((p) => p.id)).map((s) => [s.projectId, s]));
  res.json({
    projects: projects.map((p) => {
      const settings = byProject.get(p.id);
      return {
        projectId: p.id,
        projectName: p.name,
        repo: settings?.repo || "",
        installationId: settings?.installationId || "",
        enabled: !!settings?.enabled,
      };
    }),
  });
});

// PATCH /api/settings/github-checks/:projectId — opt a project in/out.
router.patch("/settings/github-checks/:projectId", requireRole("admin"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const enabled = req.body?.enabled === true;
  const repo = typeof req.body?.repo === "string" ? req.body.repo.trim() : "";
  const installationId = typeof req.body?.installationId === "string" || typeof req.body?.installationId === "number"
    ? String(req.body.installationId).trim() : "";
  if (enabled && !/^[-_.A-Za-z0-9]+\/[-_.A-Za-z0-9]+$/.test(repo)) {
    return res.status(400).json({ error: "repo must be in owner/name format" });
  }
  if (enabled && !installationId) return res.status(400).json({ error: "installationId is required when enabled" });
  const existing = githubCheckSettingsRepo.getByProjectId(project.id);
  const now = new Date().toISOString();
  const settings = githubCheckSettingsRepo.upsert({
    projectId: project.id,
    enabled,
    repo: repo || null,
    installationId: installationId || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  logActivity({ ...actor(req), type: "settings.update", detail: `GitHub PR checks ${enabled ? "enabled" : "disabled"} for ${project.name}` });
  res.json({ ok: true, settings });
});

// GET /api/ollama/status — check Ollama connectivity + list available models
router.get("/ollama/status", async (req, res) => {
  const status = await checkOllamaConnection();
  res.json(status);
});

/**
 * B2.2 — Real-network capability probe.
 *
 * Replaces the earlier catalog-copy implementation. Probe success
 * persists `capabilities: { reachable: true, auth: true, model: true,
 * jsonMode: <observed>, vision: <catalog>, source: "network" }` plus
 * an audit row tagged `action: "probe"`. Probe failure persists
 * the same shape with `reachable`/`auth`/`model` set to whichever
 * dimension failed and `errorReason` populated — the row still
 * persists so the operator can see the failure in Settings.
 *
 * The HTTP response carries `ok: true` regardless of probe outcome
 * (the request itself succeeded — the operator is asking "what is
 * the truth?"). The Settings UI inspects `capabilities.reachable`
 * to render its red/green badge (B3.1).
 */
router.post("/settings/provider-routes/:id/probe", requireRole("admin"), async (req, res) => {
  const updated = await providerRouteRepo.probeAndPersist(req.workspaceId, req.params.id, {
    userId: req.authUser?.sub || null,
  });
  if (!updated) return res.status(404).json({ error: "Route not found" });
  return res.json({ ok: true, route: updated, capabilities: updated.capabilities });
});


router.post("/settings/ai-requests/:id/replay", requireRole("admin"), async (req, res) => {
  const row = aiRequestLogRepo.getById(req.workspaceId, req.params.id);
  if (!row) return res.status(404).json({ error: "Request log not found" });
  const prompt = row.promptRedacted || "";
  if (!prompt) return res.status(400).json({ error: "Prompt payload unavailable for replay in current storage mode" });
  const routeId = req.body?.routeId || null;
  const text = await generateText(prompt, { workspaceId: req.workspaceId, agentRole: row.agentRole || undefined, routeId });
  return res.json({ ok: true, replayedFrom: row.id, routeId, text });
});

router.get("/settings/ai-requests", requireRole("admin"), (req, res) => {
  const rows = aiRequestLogRepo.list(req.workspaceId, req.query || {});
  res.json({ items: rows, nextCursor: rows.length ? rows[rows.length - 1].createdAt : null });
});

export default router;



