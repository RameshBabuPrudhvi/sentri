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
import { hasProvider, setRuntimeKey, setRuntimeOllama, setActiveProvider, checkOllamaConnection, getProviderMeta, getConfiguredKeys, getProvider, getSupportedProviders } from "../aiProvider.js";
import { actor } from "../utils/actor.js";
import { requireRole } from "../middleware/requireRole.js";
import { isDemoEnabled, getDemoQuotaStatus } from "../middleware/demoQuota.js";
import { validateUrl } from "../utils/ssrfGuard.js";
import * as apiKeyRepo from "../database/repositories/apiKeyRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as githubCheckSettingsRepo from "../database/repositories/githubCheckSettingsRepo.js";

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

  res.json({ ok: true });
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

export default router;
