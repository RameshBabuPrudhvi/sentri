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
import * as providerRouteAuditRepo from "../database/repositories/providerRouteAuditRepo.js";
import { resetRouteBreakers } from "../aiProvider/registry.js";
// B3.1 — `secrets.encryptKey` for the create/update + rotate-key paths. The
// repo layer (`providerRouteRepo.upsert`) accepts the encrypted blob +
// nonce + lastFour directly; encryption happens here so the route owns the
// AES boundary and the repo stays a pure DAL. Plaintext is never written
// to disk and never persisted on the request object beyond the call.
import * as secrets from "../aiProvider/secrets.js";
import { FAMILY_EMOJI, formatCostTier } from "../aiProvider/modelCatalog.js";

// Static family → display label map. Used by `toDisplayRoute` to render
// `displayLabel: "MyRoute (Anthropic)"` in the AI Providers dropdown.
//
// Why not use `getCloudName(row.family)` from modelCatalog.js? Because that
// function reads `process.env[envVar]` (e.g. `ANTHROPIC_MODEL`) and returns
// the raw model id when set — producing labels like "MyRoute (claude-3-opus-
// 20240229)" instead of "MyRoute (Anthropic)" for every Anthropic-family
// route in a deployment with model env overrides. This map is purely
// family→brand, no env dependency. Lifeguard BUG-0001 / BUG-0004.
const FAMILY_DISPLAY_LABEL = Object.freeze({
  anthropic:  "Anthropic",
  openai:     "OpenAI",
  google:     "Google",
  openrouter: "OpenRouter",
  local:      "Ollama",
  custom:     "Custom",
});


const router = Router();

// ── AI Provider display helpers ───────────────────────────────────────────────
//
// Augment raw provider_routes rows with display-friendly fields for the
// Settings UI and Agent Roles dropdown. Computed, never stored.
//
/**
 * Enrich a provider_routes row with display-friendly fields:
 *   displayLabel — "Claude Sonnet 4.6 (Anthropic)" for dropdowns
 *   familyEmoji  — "🔶" instant visual family ID
 *   costTier     — "$3 / $15 per M" or "Free (local)" / "Variable"
 *   usedByRoles  — Agent roles pinned to this route (reverse ref). Lets the
 *                  Settings UI render "Used by: explorer, planner" inline on
 *                  each provider row so operators see the multi-agent wiring
 *                  without tab-switching to Agent Roles.
 *
 * The `rolesByRouteId` Map is optional — single-row enrichment paths
 * (rotate-key, probe, upsert response) can omit it; the list endpoints
 * build it once for the whole workspace and pass it in to amortise the
 * agent_configs query across N rows.
 *
 * @param {Object} row - Hydrated provider_routes row.
 * @param {Map<string, string[]>} [rolesByRouteId] - routeId → role[] reverse map.
 * @returns {Object} Same row + display fields.
 */
function toDisplayRoute(row, rolesByRouteId = null) {
  if (!row) return row;
  const familyLabel = FAMILY_DISPLAY_LABEL[row.family] || row.family || "Custom";
  return {
    ...row,
    displayLabel: `${row.name} (${familyLabel})`,
    familyEmoji:  FAMILY_EMOJI[row.family] ?? "🤖",
    costTier:     formatCostTier(row.model),
    usedByRoles:  rolesByRouteId?.get(row.id) ?? [],
  };
}

/**
 * Build the routeId → role[] reverse map for a workspace in one DB call.
 * Used by the list endpoints so each row's `usedByRoles` field is
 * populated without an N+1 query.
 *
 * @param {string} workspaceId
 * @returns {Map<string, string[]>}
 */
function buildRolesByRouteId(workspaceId) {
  const map = new Map();
  for (const cfg of agentConfigRepo.listByWorkspace(workspaceId)) {
    if (!cfg.routeId) continue;
    const list = map.get(cfg.routeId) || [];
    list.push(cfg.role);
    map.set(cfg.routeId, list);
  }
  return map;
}


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

// B4.3 — `hasFallbackCycle` removed. Migration 053 dropped the
// `agent_configs.fallbackRole` column; the canonical per-route fallback
// lives on `provider_routes.fallbackRouteId` and is cycle-checked by
// `providerRouteRepo.upsert` (ERR_ROUTE_FALLBACK_CYCLE).

router.get("/settings/agent-roles", requireRole("admin"), (req, res) => {
  res.json({ roles: agentConfigRepo.listByWorkspace(req.workspaceId) });
});

router.post("/settings/agent-roles", requireRole("admin"), (req, res) => {
  // B2.1 — `provider` + `model` columns dropped (migration 048). Workspaces
  // now pin dispatch by `routeId` (a `provider_routes` row carries family +
  // model + encrypted key). The route validates `routeId` exists in this
  // workspace via `agentConfigRepo.upsert` (throws `ERR_AGENT_ROUTE_NOT_FOUND`).
  // B4.3 — `fallbackRole` dropped by migration 053. Silently ignore if
  // callers still send it (old frontend builds, API scripts).
  const { role, routeId = null, systemPromptOverride = null, temperature = 0.2, maxTokens = null } = req.body || {};
  if (!AGENT_ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
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
      maxTokens: maxTokens == null ? null : (Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : null),
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
// B4.3 — `fallbackRole` removed (column dropped by migration 053).
const PATCHABLE_AGENT_FIELDS = ["routeId", "systemPromptOverride", "temperature", "maxTokens"];

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

// ─── Provider Routes CRUD (B3.1) ─────────────────────────────────────────────
//
// Wire surface for the Settings → Provider Routes tab. Each handler is a
// thin shell over `providerRouteRepo` + `secrets.encryptKey`; validation
// and audit logging live in the repo so the HTTP boundary stays small.

// Validation enums — mirror `migrations/035_provider_routes.sql` column
// comments and `protocolForProvider.PROTOCOL_MAP`. Kept inline so the
// route file is the only thing CI has to read to verify the wire contract;
// the repo can't enforce these via SQL CHECK constraints without a
// schema change, so we gate at the HTTP boundary instead.
const PR_VALID_FAMILIES = new Set(["anthropic", "openai", "google", "openrouter", "local", "custom"]);
const PR_VALID_PROTOCOLS = new Set(["openai", "anthropic", "gemini", "ollama"]);

/**
 * Coerce, validate, and normalise the public request body into the shape
 * `providerRouteRepo.upsert` expects. Returns `{ payload, error }` —
 * `error` is non-null when validation failed (caller surfaces as 400).
 *
 * `apiKey` is encrypted here (never stored on the request object past
 * this function) and the ciphertext+nonce+lastFour are inlined into the
 * payload so the repo layer never touches plaintext.
 */
function buildProviderRoutePayload(body, { isCreate }) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const family = typeof body?.family === "string" ? body.family : "";
  const protocol = typeof body?.protocol === "string" ? body.protocol : "";
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : null;

  // Required fields on create. On update (PATCH) any of these may be
  // omitted — the repo's partial-patch semantics preserve the existing
  // column. We only re-validate the ones that ARE present.
  if (isCreate) {
    if (!name) return { error: "name is required" };
    if (!family || !PR_VALID_FAMILIES.has(family)) return { error: `family must be one of: ${[...PR_VALID_FAMILIES].join(", ")}` };
    if (!protocol || !PR_VALID_PROTOCOLS.has(protocol)) return { error: `protocol must be one of: ${[...PR_VALID_PROTOCOLS].join(", ")}` };
    if (!model) return { error: "model is required" };
  } else {
    if (family && !PR_VALID_FAMILIES.has(family)) return { error: `family must be one of: ${[...PR_VALID_FAMILIES].join(", ")}` };
    if (protocol && !PR_VALID_PROTOCOLS.has(protocol)) return { error: `protocol must be one of: ${[...PR_VALID_PROTOCOLS].join(", ")}` };
  }

  // Numeric coercion + null sentinels for the rate/cache columns.
  // The frontend sends `""` for unset numeric inputs; we normalise to
  // `null` so SQLite's INTEGER column doesn't store the empty string.
  const numOrNull = (v) => {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const payload = {};
  // Only include keys the caller actually sent so the repo's partial-
  // patch semantics work — `undefined` keeps the existing column,
  // explicit `null` clears it (per repo JSDoc).
  if (isCreate || (body && "name" in body)) payload.name = name;
  if (isCreate || (body && "family" in body)) payload.family = family;
  if (isCreate || (body && "protocol" in body)) payload.protocol = protocol;
  if (isCreate || (body && "model" in body)) payload.model = model;
  if (body && "baseUrl" in body) payload.baseUrl = baseUrl || null;
  if (body && "enabled" in body) payload.enabled = !!body.enabled;
  if (body && "rpmLimit" in body) payload.rpmLimit = numOrNull(body.rpmLimit);
  if (body && "tpmLimit" in body) payload.tpmLimit = numOrNull(body.tpmLimit);
  if (body && "cacheEnabled" in body) payload.cacheEnabled = !!body.cacheEnabled;
  if (body && "cacheTtlSec" in body) payload.cacheTtlSec = numOrNull(body.cacheTtlSec) ?? 0;
  if (body && "fallbackRouteId" in body) payload.fallbackRouteId = body.fallbackRouteId || null;

  // apiKey — plaintext on the wire, encrypted before the repo sees it.
  // Empty string MUST be treated as "no change" (the create+edit form
  // intentionally omits the key on update; leaving it empty is the
  // documented way to keep the stored ciphertext intact). Only a
  // non-empty trimmed string triggers encryption.
  if (typeof body?.apiKey === "string" && body.apiKey.trim()) {
    const plaintext = body.apiKey.trim();
    if (plaintext.length < 10) return { error: "apiKey must be at least 10 characters" };
    const enc = secrets.encryptKey(plaintext);
    payload.apiKeyEncrypted = enc.ciphertext;
    payload.apiKeyNonce = enc.nonce;
    payload.apiKeyLastFour = enc.lastFour;
  }

  return { payload };
}

/**
 * Translate the repo's typed errors into HTTP status codes. Centralised
 * so every CRUD handler surfaces the same shape — the Settings UI's
 * inline error rendering depends on the response being `{ error }` on
 * non-2xx.
 */
function handleProviderRouteError(err, res) {
  if (err?.code === "ERR_ROUTE_MISSING_FIELD") return res.status(400).json({ error: err.message });
  if (err?.code === "ERR_ROUTE_FALLBACK_CYCLE") return res.status(400).json({ error: err.message });
  throw err;
}

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
/**
 * List every provider route in the caller's workspace. Repo's `list`
 * uses the safe SELECT — secret blobs (`apiKeyEncrypted`, `apiKeyNonce`)
 * are omitted, only `apiKeyLastFour` comes back for the UI's masked
 * display. Workspace scoping is enforced by the repo's WHERE clause.
 */
router.get("/settings/provider-routes", requireRole("admin"), (req, res) => {
  const rolesByRouteId = buildRolesByRouteId(req.workspaceId);
  res.json({ routes: providerRouteRepo.list(req.workspaceId).map((r) => toDisplayRoute(r, rolesByRouteId)) });
});

/**
 * Create a new provider route. Returns 201 with the freshly persisted
 * row (re-read via the repo so JSON columns hydrate). Audit row is
 * appended in the same transaction by the repo.
 */
router.post("/settings/provider-routes", requireRole("admin"), (req, res) => {
  const { payload, error } = buildProviderRoutePayload(req.body || {}, { isCreate: true });
  if (error) return res.status(400).json({ error });
  try {
    const saved = providerRouteRepo.upsert({
      ...payload,
      workspaceId: req.workspaceId,
      userId: req.authUser?.sub || null,
    });
    logActivity({ ...actor(req), type: "settings.update", detail: `Provider route created: ${saved.name}` });
    res.status(201).json(toDisplayRoute(saved));
  } catch (err) {
    return handleProviderRouteError(err, res);
  }
});

/**
 * Partial-patch an existing route. The repo's `upsert` honours partial
 * input — any MUTABLE_FIELDS column left undefined keeps its existing
 * value. The frontend's edit form deliberately omits `apiKey` so the
 * stored ciphertext is preserved on every non-rotation save.
 *
 * PATCH explicitly REJECTS an `apiKey` field — key rotation must go
 * through `POST /:id/rotate-key` so the audit row is correctly tagged
 * `action: "rotate_key"` (the repo's diff-based audit infers
 * `rotate_key` from `changed.includes("apiKeyEncrypted")`, but the
 * dedicated endpoint also runs a probe-before-persist gate that
 * PATCH doesn't).
 */
router.patch("/settings/provider-routes/:id", requireRole("admin"), (req, res) => {
  const existing = providerRouteRepo.getById(req.workspaceId, req.params.id);
  if (!existing) return res.status(404).json({ error: "Route not found" });
  const { payload, error } = buildProviderRoutePayload(req.body || {}, { isCreate: false });
  if (error) return res.status(400).json({ error });
  if (payload.apiKeyEncrypted) {
    return res.status(400).json({ error: "Use POST /settings/provider-routes/:id/rotate-key to change the API key" });
  }
  try {
    const saved = providerRouteRepo.upsert({
      ...payload,
      id: existing.id,
      workspaceId: req.workspaceId,
      userId: req.authUser?.sub || null,
    });
    logActivity({ ...actor(req), type: "settings.update", detail: `Provider route updated: ${saved.name}` });
    res.json(saved);
  } catch (err) {
    return handleProviderRouteError(err, res);
  }
});

/**
 * Delete a route. Two referential-integrity guards run before the repo
 * touches the row:
 *
 *   1. **`agent_configs.routeId` references** — checklist B3.3 requires
 *      the DELETE to REFUSE when any agent role is pinned to this
 *      route. Without this gate an admin could one-click-break every
 *      workspace pipeline by deleting the route those roles dispatch
 *      against. We list the offending roles in the 409 response so
 *      the Settings UI can show the operator "reassign these roles
 *      first" rather than a bare "in use" error.
 *
 *   2. **Sibling `provider_routes.fallbackRouteId` references** — the
 *      repo nulls these in the same transaction as the delete (see
 *      `providerRouteRepo.remove` JSDoc) so dispatch can rely on every
 *      non-null fallback pointing at an existing row. No HTTP-level
 *      guard needed because the cascading null is the documented
 *      contract, not a footgun.
 */
router.delete("/settings/provider-routes/:id", requireRole("admin"), (req, res) => {
  const existing = providerRouteRepo.getById(req.workspaceId, req.params.id);
  if (!existing) return res.status(404).json({ error: "Route not found" });
  // B3.3 guard — refuse with 409 when any agent_configs row pins this
  // routeId. `listByWorkspace` is cheap (workspace-scoped index) so we
  // don't pay for a dedicated repo helper just for this check.
  const pinnedRoles = agentConfigRepo.listByWorkspace(req.workspaceId)
    .filter((c) => c.routeId === existing.id)
    .map((c) => c.role);
  if (pinnedRoles.length > 0) {
    return res.status(409).json({
      error: `Route is in use by agent role(s): ${pinnedRoles.join(", ")}. Reassign or clear those roles before deleting.`,
      code: "ERR_ROUTE_IN_USE",
      pinnedRoles,
    });
  }
  const result = providerRouteRepo.remove(req.workspaceId, req.params.id, { userId: req.authUser?.sub || null });
  logActivity({ ...actor(req), type: "settings.update", detail: `Provider route deleted: ${existing.name}` });
  res.json({ ok: true, ...result });
});

/**
 * B3.6 — Rotate the route's API key. Encrypts the new plaintext, runs
 * a network probe against the candidate key BEFORE persisting so the
 * rotation is rejected when the new key doesn't work, then writes via
 * the repo (which audits with `action: "rotate_key"` and invalidates
 * the plaintext cache).
 *
 * Probe-before-persist gates the rotation: a key that doesn't probe
 * green never replaces the working stored key. This is the "rejects on
 * probe fail" contract from the roadmap that every B4.4 secrets-
 * rotation E2E test depends on.
 *
 * The probe-against-candidate is done by temporarily swapping the
 * route's ciphertext+nonce, running `capabilityProbe.runCapabilityProbe`
 * on the swapped row, then restoring the original on failure. We do
 * this via the repo so the swap is transactional and any failure
 * mid-probe leaves the stored key untouched.
 */
router.post("/settings/provider-routes/:id/rotate-key", requireRole("admin"), async (req, res) => {
  const existing = providerRouteRepo.getById(req.workspaceId, req.params.id);
  if (!existing) return res.status(404).json({ error: "Route not found" });
  // B3.6 — accept both `apiKey` (B3.1 client) and `newApiKey` (B3.6
  // checklist body shape). Either name is fine because the wire
  // contract is identical; supporting both keeps the existing
  // frontend client working while documenting the canonical name
  // from the roadmap.
  const rawKey = (typeof req.body?.newApiKey === "string" && req.body.newApiKey)
    || (typeof req.body?.apiKey === "string" && req.body.apiKey)
    || "";
  const plaintext = rawKey.trim();
  if (!plaintext || plaintext.length < 10) {
    return res.status(400).json({ error: "newApiKey is required and must be at least 10 characters" });
  }
  // Snapshot the prior ciphertext BEFORE the rotation so probe-fail
  // rollback can restore it. `getById` uses the SAFE_SELECT that omits
  // secret columns, so we have to call `getSecretById` explicitly here.
  // Captured up front so the rollback can't accidentally read the
  // freshly-written ciphertext after the upsert below.
  const priorSecret = providerRouteRepo.getSecretById(req.workspaceId, existing.id);
  // Encrypt OUTSIDE the persist boundary so a probe-fail rollback never
  // leaves a half-written row. The repo's upsert detects the new
  // ciphertext via diff and emits `action: "rotate_key"` automatically.
  const enc = secrets.encryptKey(plaintext);
  try {
    const saved = providerRouteRepo.upsert({
      id: existing.id,
      workspaceId: req.workspaceId,
      userId: req.authUser?.sub || null,
      apiKeyEncrypted: enc.ciphertext,
      apiKeyNonce: enc.nonce,
      apiKeyLastFour: enc.lastFour,
      // B2.2 — suppress the auto-probe-on-upsert here. We run the
      // probe SYNCHRONOUSLY immediately below (the probe-before-
      // persist gate needs the result inline), so letting the
      // setImmediate auto-probe fire too would double-probe on every
      // key rotation.
      skipAutoProbe: true,
    });
    // Probe the freshly-rotated key. If it fails reachability or auth,
    // restore the previous ciphertext+nonce so the rotation is a no-op.
    // The probe result is persisted to `capabilities` regardless so the
    // Settings UI can show the operator what went wrong.
    const probed = await providerRouteRepo.probeAndPersist(req.workspaceId, existing.id, {
      userId: req.authUser?.sub || null,
    });
    const caps = probed?.capabilities;
    const probeOk = caps && caps.reachable && caps.auth !== false && caps.model !== false;
    if (!probeOk) {
      // Roll back to the snapshot captured BEFORE the upsert. The
      // repo's diff-based audit emits ANOTHER rotate_key row pointing
      // at the prior `lastFour` — operators see the full
      // rotate→rollback sequence in the audit log, which is the
      // desired forensic shape.
      //
      // ALSO restore `capabilities` — `probeAndPersist` just wrote the
      // FAILED probe result for the new key into the row, but after
      // rollback the row's stored key is the old known-good one whose
      // last successful probe lives on `existing.capabilities`. Without
      // this restore, every Settings UI badge + system component reading
      // `route.capabilities.reachable` (vision-heal resolver in
      // `aiProvider/vision.js`, health-check probes) sees the stale
      // failed-probe payload for a route that actually dispatches fine,
      // potentially leading operators to delete a working route.
      providerRouteRepo.upsert({
        id: existing.id,
        workspaceId: req.workspaceId,
        userId: req.authUser?.sub || null,
        apiKeyEncrypted: priorSecret?.apiKeyEncrypted ?? null,
        apiKeyNonce: priorSecret?.apiKeyNonce ?? null,
        apiKeyLastFour: priorSecret?.apiKeyLastFour ?? null,
        // Snapshot was taken via `getById` at the top of the handler —
        // before `probeAndPersist` clobbered the column with the failed
        // probe payload, so this is the LAST KNOWN-GOOD capabilities
        // shape (or `null` if the route had never been probed). The
        // diff-aware upsert detects the change and writes back; the
        // resulting `action: "update"` audit row with `changed:
        // ["capabilities"]` is desired forensic context.
        capabilities: existing.capabilities ?? null,
        // B2.2 — suppress auto-probe on the rollback write. The prior
        // key was already known-good (it was working before this
        // attempt); re-probing it on rollback would waste an API call
        // confirming what we already know AND would re-clobber the
        // capabilities we just restored.
        skipAutoProbe: true,
      });
      return res.status(400).json({
        error: "Probe failed — new key was rejected",
        reason: caps?.errorReason || "probe_failed",
        capabilities: caps,
      });
    }
    // B3.6 — clear every circuit-breaker entry keyed off this route id
    // (bare + role-scoped) so the freshly-rotated key isn't shadowed by
    // a breaker tripped on the prior credentials. Without this, a route
    // that was rate-limited under the old key would keep returning
    // breaker-open errors for `CIRCUIT_BREAKER_COOLDOWN_MS` after a
    // successful rotation — the new key would never get a chance to
    // dispatch until the cooldown elapsed.
    resetRouteBreakers(existing.id);
    logActivity({
      ...actor(req),
      type: "auth.api_key.rotate",
      req,
      workspaceId: req.workspaceId,
      meta: { routeId: existing.id, routeName: existing.name, lastFour: enc.lastFour },
    });
    res.json({ ok: true, lastFour: enc.lastFour, route: saved, capabilities: caps });
  } catch (err) {
    return handleProviderRouteError(err, res);
  }
});

router.post("/settings/provider-routes/:id/probe", requireRole("admin"), async (req, res) => {
  const updated = await providerRouteRepo.probeAndPersist(req.workspaceId, req.params.id, {
    userId: req.authUser?.sub || null,
  });
  if (!updated) return res.status(404).json({ error: "Route not found" });
  return res.json({ ok: true, route: updated, capabilities: updated.capabilities });
});

/**
 * B3.9 — Provider routes audit log viewer.
 *
 * Workspace-scoped, paginated, filterable. Mirrors the cursor-pagination
 * shape of `GET /settings/ai-requests` so the frontend's audit subtab
 * can reuse the same "load more" pattern. `metadata` round-trips as a
 * JSON string per the repo contract — frontend `JSON.parse`s on render.
 *
 * Query params (all optional):
 *   • `routeId`  — filter to a single route's history
 *   • `action`   — one of {create, update, delete, rotate_key, probe, export, import}
 *   • `since`    — ISO timestamp; rows with `createdAt >= since`
 *   • `before`   — ISO timestamp; rows with `createdAt < before` (cursor)
 *   • `limit`    — clamped to [1, 500] by the repo
 *
 * `since` is a B3.9-specific filter (the repo's `list` only supports
 * `before`). We intersect it via post-filter rather than extend the
 * repo because the workspace-scoped `(workspaceId, createdAt)` index
 * already narrows the working set to days-of-data per workspace —
 * a JS-side filter on a few hundred rows is cheaper than adding
 * another SQL clause that complicates the repo's typed surface.
 */
router.get("/settings/provider-routes/audit", requireRole("admin"), (req, res) => {
  const opts = {
    routeId: typeof req.query.routeId === "string" ? req.query.routeId : undefined,
    action: typeof req.query.action === "string" ? req.query.action : undefined,
    before: typeof req.query.before === "string" ? req.query.before : undefined,
    limit: Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 50,
  };
  let rows = providerRouteAuditRepo.list(req.workspaceId, opts);
  // Optional `since` post-filter — see JSDoc above for why we don't
  // push this into the repo. ISO compare is lexicographically correct
  // for fixed-format timestamps so we don't need to parse to Date.
  if (typeof req.query.since === "string" && req.query.since) {
    rows = rows.filter((r) => r.createdAt >= req.query.since);
  }
  res.json({
    items: rows,
    nextCursor: rows.length ? rows[rows.length - 1].createdAt : null,
  });
});

// ─── Provider Routes export / import (B3.5) ──────────────────────────────────
//
// Portable JSON representation of a workspace's `provider_routes` rows.
// Schema is owned by `docs/schema/provider-routes-v1.json` — keep the
// constants here in sync if the schema bumps. Secrets are NEVER written
// to the export payload: `apiKeyEncrypted` and `apiKeyNonce` are
// omitted entirely; only `apiKeyLastFour` round-trips so operators can
// match imported rows to their real out-of-band keys.

const PROVIDER_ROUTES_SCHEMA_VERSION = 1;
const PROVIDER_ROUTES_SCHEMA_ID = "https://schemas.sentri.dev/provider-routes-v1.json";
// Bounded parallelism for the post-import probe sweep. Operators
// importing a 20-route bundle shouldn't fan out 20 simultaneous
// provider calls — a small pool keeps the worst-case cost predictable
// without sequentially blocking the response on each probe.
const IMPORT_PROBE_PARALLELISM = 3;
const IMPORT_VALID_MODES = new Set(["skip", "overwrite", "rename"]);

/**
 * Strip a `provider_routes` row down to the schema-v1 export shape.
 * Drops `apiKeyEncrypted` / `apiKeyNonce` and any internal-only fields;
 * preserves operator-set metadata (`pricing`, `capabilities`, rate
 * limits) so a round-trip preserves intent. The repo's `list` already
 * uses the safe SELECT (secret blobs excluded), but we re-pick the
 * allowed columns explicitly here so a future schema column doesn't
 * accidentally leak through the export.
 */
function serialiseRouteForExport(row) {
  return {
    id: row.id ?? null,
    name: row.name,
    family: row.family,
    protocol: row.protocol,
    baseUrl: row.baseUrl ?? null,
    model: row.model,
    apiKeyLastFour: row.apiKeyLastFour ?? null,
    enabled: row.enabled === 1 || row.enabled === true,
    rpmLimit: row.rpmLimit ?? null,
    tpmLimit: row.tpmLimit ?? null,
    cacheEnabled: row.cacheEnabled === 1 || row.cacheEnabled === true,
    cacheTtlSec: row.cacheTtlSec ?? 0,
    fallbackRouteId: row.fallbackRouteId ?? null,
    capabilities: row.capabilities ?? null,
    pricing: row.pricing ?? null,
  };
}

/**
 * Forward-compat shim. The current implementation only knows v1, but
 * the contract from the checklist is "forward-compat shim for older
 * versions". When v2 ships, this is where we add
 * `if (version === 1) return upgradeV1ToV2(payload)`. For now: accept
 * v1 verbatim, refuse everything else.
 */
function normaliseImportPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const v = payload.schemaVersion;
  if (v === PROVIDER_ROUTES_SCHEMA_VERSION) return { payload };
  return {
    error: `Unsupported schemaVersion ${v}. This server understands schemaVersion ${PROVIDER_ROUTES_SCHEMA_VERSION}.`,
  };
}

/**
 * Resolve a name collision per the requested mode. Returns either
 * `{ name }` with the final name to use, `{ skip: true }` when the
 * route should be skipped, or `{ error }` for malformed state.
 */
function resolveImportName({ desiredName, existingNames, importedNames, mode }) {
  const collides = existingNames.has(desiredName);
  if (!collides) return { name: desiredName };
  if (mode === "skip") return { skip: true };
  if (mode === "overwrite") return { name: desiredName };
  // mode === "rename" — append -2, -3, … until no collision against
  // existing OR freshly-imported routes.
  let suffix = 2;
  while (suffix < 1000) {
    const candidate = `${desiredName}-${suffix}`;
    if (!existingNames.has(candidate) && !importedNames.has(candidate)) {
      return { name: candidate };
    }
    suffix += 1;
  }
  return { error: `Could not find a non-colliding name for "${desiredName}" after 1000 attempts` };
}

/**
 * Run an async fn over an array with bounded parallelism. Returns
 * after every item resolves. Errors are caught and returned per-item
 * so a single probe failure can't fail the import.
 */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      try {
        results[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (err) {
        results[idx] = { ok: false, error: err?.message || String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * GET /settings/provider-routes/export — schema-v1 JSON dump.
 *
 * Sets `Content-Disposition: attachment` so a browser navigation
 * triggers a download. The frontend's `api.exportRoutes` helper uses
 * fetch + Blob to handle cross-origin deploys (cookies aren't sent on
 * navigations in that mode); same-origin can navigate directly.
 *
 * Audit row: `action: "export"` with `metadata: { count, schemaVersion }`.
 * `routeId` is null because export is workspace-scoped, not route-scoped.
 */
router.get("/settings/provider-routes/export", requireRole("admin"), (req, res) => {
  const rows = providerRouteRepo.list(req.workspaceId);
  const payload = {
    $schema: PROVIDER_ROUTES_SCHEMA_ID,
    schemaVersion: PROVIDER_ROUTES_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workspaceId: req.workspaceId,
    routes: rows.map(serialiseRouteForExport),
  };
  providerRouteAuditRepo.append({
    workspaceId: req.workspaceId,
    routeId: null,
    userId: req.authUser?.sub || null,
    action: "export",
    metadata: { count: rows.length, schemaVersion: PROVIDER_ROUTES_SCHEMA_VERSION },
  });
  logActivity({
    ...actor(req),
    type: "settings.update",
    detail: `Exported ${rows.length} provider route(s)`,
  });
  // Filename includes workspaceId tail + date so multiple exports from
  // different workspaces don't collide in the operator's Downloads
  // folder. ISO date (no time) is enough granularity — the audit log
  // carries the millisecond timestamp.
  const dateStr = new Date().toISOString().slice(0, 10);
  const wsTail = String(req.workspaceId || "ws").slice(-6);
  res.setHeader("Content-Disposition", `attachment; filename="sentri-provider-routes-${wsTail}-${dateStr}.json"`);
  res.json(payload);
});

/**
 * POST /settings/provider-routes/import — upsert routes from a v1 JSON
 * payload.
 *
 * Two-phase apply:
 *   1. Upsert each row (resolving name collisions per `mode`), capturing
 *      the source→destination id map for the next phase.
 *   2. Re-resolve `fallbackRouteId` using the map, then write back via
 *      a second upsert. Done as a second pass because forward
 *      references (route A's fallback points at route B, but B hasn't
 *      been created yet) would otherwise fail the repo's
 *      `wouldCreateCycle` check on the first pass.
 *
 * Capability probe is then run with bounded parallelism so the
 * importer never fans out more than `IMPORT_PROBE_PARALLELISM`
 * concurrent provider calls. Probe failures don't fail the import —
 * the route lands with `capabilities: { reachable: false, ... }` so
 * the operator sees the failure in Settings and can fix the key
 * out-of-band before depending on the route.
 *
 * Audit row: `action: "import"` with `metadata: { created, overwritten,
 * skipped, renamed, schemaVersion }`. `routeId` is null because the
 * event is workspace-scoped.
 */
router.post("/settings/provider-routes/import", requireRole("admin"), async (req, res) => {
  const { payload: body, error: shimErr } = normaliseImportPayload(req.body);
  if (shimErr) return res.status(400).json({ error: shimErr });

  const mode = String(req.body?.mode || "").toLowerCase();
  if (!IMPORT_VALID_MODES.has(mode)) {
    return res.status(400).json({
      error: `mode must be one of: ${[...IMPORT_VALID_MODES].join(", ")}`,
    });
  }
  if (!Array.isArray(body.routes)) {
    return res.status(400).json({ error: "routes must be an array" });
  }

  // Snapshot existing names BEFORE any writes so collisions are
  // resolved against the pre-import state, not state mutated mid-loop.
  const existingByName = new Map(
    providerRouteRepo.list(req.workspaceId).map((r) => [r.name, r]),
  );
  const existingNames = new Set(existingByName.keys());
  const importedNames = new Set();
  // sourceId → destinationId, used in phase 2 to rewire `fallbackRouteId`.
  const idMap = new Map();
  // Final landed routes, indexed by destination id so phase 2 can patch
  // them without re-fetching from the repo.
  const landed = [];
  const stats = { created: 0, overwritten: 0, skipped: 0, renamed: 0, errors: [] };

  for (const incoming of body.routes) {
    if (!incoming || typeof incoming !== "object" || typeof incoming.name !== "string") {
      stats.errors.push({ name: incoming?.name ?? null, error: "missing or invalid name" });
      continue;
    }
    const resolved = resolveImportName({
      desiredName: incoming.name,
      existingNames,
      importedNames,
      mode,
    });
    if (resolved.error) {
      stats.errors.push({ name: incoming.name, error: resolved.error });
      continue;
    }
    if (resolved.skip) {
      stats.skipped += 1;
      continue;
    }
    const finalName = resolved.name;
    const isRename = finalName !== incoming.name;
    const isOverwrite = mode === "overwrite" && existingNames.has(incoming.name);

    // Build the payload. Re-use the create/update validator so the
    // imported shape is enforced the same way as direct API calls;
    // any operator who hand-edits the JSON to smuggle in a bogus
    // family gets the same 400 they'd get from POST.
    const candidateBody = {
      name: finalName,
      family: incoming.family,
      protocol: incoming.protocol,
      baseUrl: incoming.baseUrl ?? null,
      model: incoming.model,
      enabled: incoming.enabled !== false,
      rpmLimit: incoming.rpmLimit ?? null,
      tpmLimit: incoming.tpmLimit ?? null,
      cacheEnabled: !!incoming.cacheEnabled,
      cacheTtlSec: Number.isFinite(incoming.cacheTtlSec) ? incoming.cacheTtlSec : 0,
      // fallbackRouteId is rewired in phase 2 — leave it null on the
      // first pass so the cycle check can't trip on a forward reference.
      fallbackRouteId: null,
      // apiKey is NEVER in the export, so the import never carries one.
      // The route lands keyless and the operator re-supplies via
      // rotate-key after import.
    };
    // `isCreate` controls validation strictness: when overwriting an
    // existing row we still want all required fields present so the
    // overwrite can't silently drop columns.
    const { payload, error } = buildProviderRoutePayload(candidateBody, { isCreate: true });
    if (error) {
      stats.errors.push({ name: incoming.name, error });
      continue;
    }

    try {
      // B3.5 fix — pass the existing row's `id` explicitly on overwrite
      // so the repo takes the deterministic by-id path instead of
      // falling back to its name-based lookup. The fallback worked by
      // coincidence today (the SAFE_SELECT happens to return rows by
      // name when `id` is unset on the input), but it's fragile: a
      // future refactor that prunes the unused-`id` branch would
      // silently turn every overwrite into a duplicate-key
      // `UNIQUE(workspaceId, name)` collision. Be explicit.
      //
      // When mode is `rename`, finalName differs from incoming.name and
      // there's no existing row to overwrite — leave `id` unset so the
      // repo treats the call as INSERT.
      const overwriteTarget = isOverwrite ? existingByName.get(incoming.name) : null;
      const saved = providerRouteRepo.upsert({
        ...payload,
        ...(overwriteTarget ? { id: overwriteTarget.id } : {}),
        // Honour operator-set pricing JSON if present. `payload`
        // doesn't include it (the build helper is for the wire CRUD
        // shape); we pass it through verbatim per the schema contract.
        pricing: incoming.pricing ?? null,
        workspaceId: req.workspaceId,
        userId: req.authUser?.sub || null,
        // B2.2 — suppress auto-probe per row. Phase 3 below probes
        // every landed route with bounded parallelism so the import
        // doesn't fan out N simultaneous provider calls. Letting the
        // setImmediate auto-probe ALSO fire would defeat that bound
        // and double-probe every imported route.
        skipAutoProbe: true,
      });
      importedNames.add(finalName);
      // B3.5 fix — always populate `idMap` (incoming.id → saved.id) for
      // phase-2 fallback rewire to work. The previous `if (incoming.id)`
      // gate dropped rows whose source-side `id` was absent (e.g.
      // exports from older tooling, hand-edited bundles), silently
      // breaking the fallback chain for those entries. Use a stable
      // synthetic key when `incoming.id` is missing so the map still
      // covers the entry — `_imp:<name>` collides with neither real
      // ids (`pr-*`) nor group ids (`rg-*`).
      const sourceKey = incoming.id || `_imp:${incoming.name}`;
      idMap.set(sourceKey, saved.id);
      // Capture the source key alongside the saved row so phase 2 can
      // resolve `incoming.fallbackRouteId` (which may be a real
      // source-side id OR a `_imp:<name>` synthetic) without a second
      // lookup pass.
      landed.push({
        saved,
        sourceFallbackId: incoming.fallbackRouteId ?? null,
      });
      if (isOverwrite) stats.overwritten += 1;
      else if (isRename) stats.renamed += 1;
      else stats.created += 1;
    } catch (err) {
      stats.errors.push({
        name: incoming.name,
        error: err?.code === "ERR_ROUTE_MISSING_FIELD" || err?.code === "ERR_ROUTE_FALLBACK_CYCLE"
          ? err.message
          : "upsert_failed",
      });
    }
  }

  // ── Phase 2: rewire fallback chains ─────────────────────────────────
  // Walk every landed row, resolve the source fallbackRouteId via the
  // id map, and patch the destination row. The repo's cycle check
  // catches loops introduced by the rewire (which would happen if
  // the source export itself contained a cycle — defensive guard).
  for (const { saved, sourceFallbackId } of landed) {
    if (!sourceFallbackId) continue;
    const destFallbackId = idMap.get(sourceFallbackId) || null;
    if (!destFallbackId) continue;
    try {
      providerRouteRepo.upsert({
        id: saved.id,
        workspaceId: req.workspaceId,
        userId: req.authUser?.sub || null,
        fallbackRouteId: destFallbackId,
        // B2.2 — `fallbackRouteId` isn't in PROBE_RELEVANT_FIELDS
        // (it's a routing-chain field, not a reachability field), so
        // the auto-probe wouldn't fire on this change anyway.
        // Setting `skipAutoProbe: true` makes the intent explicit so a
        // future change to PROBE_RELEVANT_FIELDS doesn't accidentally
        // double-probe the import.
        skipAutoProbe: true,
      });
    } catch (err) {
      // Cycle in the source export — landed row keeps fallbackRouteId
      // = null. Surface as an error so the operator sees the issue.
      stats.errors.push({
        name: saved.name,
        error: err?.code === "ERR_ROUTE_FALLBACK_CYCLE"
          ? "imported fallback chain would create a cycle; left unset"
          : "fallback_rewire_failed",
      });
    }
  }

  // ── Phase 3: bounded-parallel capability probe ──────────────────────
  // Each route gets a fresh probe so stale `capabilities` from the
  // source workspace can't mislead the operator on the destination.
  // Failures land on the row as `reachable: false` + errorReason and
  // are counted but don't fail the import.
  const probeResults = await mapWithConcurrency(
    landed,
    IMPORT_PROBE_PARALLELISM,
    ({ saved }) => providerRouteRepo.probeAndPersist(req.workspaceId, saved.id, {
      userId: req.authUser?.sub || null,
    }),
  );
  const probesReachable = probeResults.filter((r) => r.ok && r.value?.capabilities?.reachable).length;

  providerRouteAuditRepo.append({
    workspaceId: req.workspaceId,
    routeId: null,
    userId: req.authUser?.sub || null,
    action: "import",
    metadata: {
      schemaVersion: PROVIDER_ROUTES_SCHEMA_VERSION,
      mode,
      created: stats.created,
      overwritten: stats.overwritten,
      skipped: stats.skipped,
      renamed: stats.renamed,
      errors: stats.errors.length,
      probesReachable,
    },
  });
  logActivity({
    ...actor(req),
    type: "settings.update",
    detail: `Imported ${landed.length} provider route(s) [${mode}]`,
  });

  res.json({
    ok: true,
    ...stats,
    probesReachable,
    total: landed.length,
  });
});


/**
 * B2.5 — Replay a logged AI request against a route.
 *
 * Three layers of validation before the LLM is called:
 *
 *   1. **Log row exists in this workspace** (404). Cross-workspace
 *      replay would leak prompts, so `aiRequestLogRepo.getById` is
 *      workspace-scoped and we never widen here.
 *   2. **Storage mode is `"full"`** (400). Replaying redacted prompts
 *      (`[REDACTED_EMAIL]` placeholders) is meaningless — the LLM sees
 *      sentinel strings instead of the actual values and the response
 *      is not informative for debugging. Metadata-only (`"none"`) rows
 *      have no prompt at all. The roadmap risk register (B2.5) ties
 *      `"full"` mode to an explicit compliance acknowledgement; the
 *      replay endpoint enforces that contract here.
 *   3. **`routeId` (when provided) exists in this workspace** (400).
 *      Lets operators replay against a DIFFERENT route than the
 *      original — useful for "did the gpt-4o-mini call actually need
 *      claude-sonnet?" debugging. When `routeId` is null the replay
 *      uses the same `agentRole` resolution the original call did
 *      (via `generateText`).
 *
 * The replay forces `requestLogMode: "full"` on the recursive call so
 * the replay itself lands in `ai_request_log` with a fresh row — admins
 * can chain "replay → see the new row → compare diff" without flipping
 * workspace settings between attempts.
 *
 * Cost note: replays charge the operator's account at the route's
 * regular billing rate. There's no "replay discount" — if the original
 * call cost $0.04, the replay costs $0.04 too. The roadmap's spend cap
 * (B3.7) covers this without special-casing.
 */
router.post("/settings/ai-requests/:id/replay", requireRole("admin"), async (req, res) => {
  const row = aiRequestLogRepo.getById(req.workspaceId, req.params.id);
  if (!row) return res.status(404).json({ error: "Request log not found" });

  // The row's `promptRedacted` column is named after the storage mode
  // semantics — under `"full"` mode it carries the RAW prompt, under
  // `"redacted"` it carries the redacted text, under `"none"` it's
  // NULL. Distinguish "no prompt" (`"none"`) from "redacted prompt"
  // (`"redacted"`) by checking the stored prompt for redaction
  // sentinels rather than guessing from mode (we don't store the
  // mode-at-write-time on the row). Anything containing `[REDACTED_`
  // came from the redaction pipeline; anything else is either full
  // or empty.
  if (!row.promptRedacted) {
    return res.status(400).json({
      error: "Prompt unavailable for replay — workspace storage mode was 'none' at write time. Switch to 'full' and capture a new call before replaying.",
    });
  }
  if (/\[REDACTED_(EMAIL|PHONE|SSN|CARD|CUSTOM)\]/.test(row.promptRedacted)) {
    return res.status(400).json({
      error: "Prompt is redacted — replay would send sentinel strings to the LLM instead of the original values. Switch the workspace to 'full' storage mode and capture a new call to replay against.",
    });
  }

  const prompt = row.promptRedacted;
  const overrideRouteId = req.body?.routeId || null;

  // Validate route override (when supplied) belongs to this workspace —
  // mirrors `agentConfigRepo.upsert`'s cross-workspace guard.
  if (overrideRouteId) {
    const route = providerRouteRepo.getById(req.workspaceId, overrideRouteId);
    if (!route) {
      return res.status(400).json({ error: "routeId not found in workspace: " + overrideRouteId });
    }
  }

  // Replay path A: `routeId` override → dispatch directly against the
  // specified route via the protocol adapter, bypassing role resolution.
  // Replay path B: no override → `generateText` resolves the agent role's
  // configured route the same way the original call did.
  let text;
  try {
    if (overrideRouteId) {
      // Direct route dispatch: build the messages, resolve the key from
      // the route, and call the protocol adapter. The route may belong
      // to a different family than the original call — fine, replay
      // is explicit about that.
      const route = providerRouteRepo.getById(req.workspaceId, overrideRouteId);
      const { generate: protocolGenerate } =
        await import("../aiProvider/adapters/protocolAdapter.js");
      const result = await protocolGenerate(
        route,
        { system: null, user: prompt, combined: prompt },
        { maxTokens: 4096, responseFormat: "text" },
      );
      text = result?.text || "";
    } else {
      text = await generateText(prompt, {
        workspaceId: req.workspaceId,
        agentRole: row.agentRole || undefined,
        // Force "full" mode on the recursive call so the replay
        // surface in `ai_request_log` is itself replayable later.
        requestLogMode: "full",
      });
    }
  } catch (err) {
    return res.status(502).json({
      error: "Replay failed: " + (err?.message?.slice(0, 200) || "unknown error"),
      replayedFrom: row.id,
      routeId: overrideRouteId,
    });
  }

  return res.json({ ok: true, replayedFrom: row.id, routeId: overrideRouteId, text });
});

router.get("/settings/ai-requests", requireRole("admin"), (req, res) => {
  const rows = aiRequestLogRepo.list(req.workspaceId, req.query || {});
  res.json({ items: rows, nextCursor: rows.length ? rows[rows.length - 1].createdAt : null });
});

// ── /settings/ai-providers — renamed aliases for /settings/provider-routes ───
//
// "AI Providers" is the new operator-facing name for what was called
// "Provider Routes". Every CRUD + probe + rotate-key operation is aliased
// here so the frontend can call /settings/ai-providers without a DB
// migration. The old /settings/provider-routes paths are preserved for
// backward compat (existing integrations, runbooks, exported JSON schema).
//
// Each alias is a thin one-liner that calls the identical handler body
// inline — no shared closure needed because the handlers read from
// req.workspaceId / req.params / req.body / req.authUser which are the
// same on both paths.

/** List all AI Providers (= provider_routes) for this workspace. */
router.get("/settings/ai-providers", requireRole("admin"), (req, res) => {
  const rolesByRouteId = buildRolesByRouteId(req.workspaceId);
  res.json({ routes: providerRouteRepo.list(req.workspaceId).map((r) => toDisplayRoute(r, rolesByRouteId)) });
});

/** Create a new AI Provider. */
router.post("/settings/ai-providers", requireRole("admin"), (req, res) => {
  const { payload, error } = buildProviderRoutePayload(req.body || {}, { isCreate: true });
  if (error) return res.status(400).json({ error });
  try {
    const saved = providerRouteRepo.upsert({
      ...payload,
      workspaceId: req.workspaceId,
      userId: req.authUser?.sub || null,
    });
    logActivity({ ...actor(req), type: "settings.update", detail: `AI Provider created: ${saved.name}` });
    res.status(201).json(toDisplayRoute(saved));
  } catch (err) {
    return handleProviderRouteError(err, res);
  }
});

/** Partial-update an AI Provider. */
router.patch("/settings/ai-providers/:id", requireRole("admin"), (req, res) => {
  const existing = providerRouteRepo.getById(req.workspaceId, req.params.id);
  if (!existing) return res.status(404).json({ error: "AI provider not found" });
  // Migration 059 — `isWorkspaceDefault` has side effects on other rows
  // (clears any previous default in the same transaction). Force callers
  // through the dedicated endpoint so the audit row is correctly tagged.
  if (req.body && "isWorkspaceDefault" in req.body)
    return res.status(400).json({ error: "Use POST /settings/ai-providers/:id/default to pin as workspace default" });
  const { payload, error } = buildProviderRoutePayload(req.body || {}, { isCreate: false });
  if (error) return res.status(400).json({ error });
  // Mirror the legacy `/provider-routes/:id` semantics — only reject when
  // a non-empty key was supplied (which `buildProviderRoutePayload` would
  // have encrypted into `payload.apiKeyEncrypted`). An empty string is the
  // documented "keep existing key" sentinel and must be a no-op, matching
  // the frontend's FORM_EMPTY shape and direct API callers that send
  // `apiKey: ""` to express "no change". Lifeguard-flagged contract drift.
  if (payload.apiKeyEncrypted)
    return res.status(400).json({ error: "Use POST /settings/ai-providers/:id/rotate-key to change the API key" });
  try {
    const updated = providerRouteRepo.upsert({
      ...payload,
      id: existing.id,
      workspaceId: req.workspaceId,
      userId: req.authUser?.sub || null,
    });
    // Lifeguard BUG-0006 — operator-facing activity log entry. The repo's
    // own audit (`providerRouteAuditRepo`) captures the field-level diff;
    // this row surfaces "what changed" in the workspace activity stream
    // so admins watching the audit page see the rename / re-enable / etc.
    // without filtering on a separate provider-routes-audit subtab.
    logActivity({ ...actor(req), type: "settings.update", detail: `AI Provider updated: ${updated.name}` });
    res.json(toDisplayRoute(updated));
  } catch (err) {
    return handleProviderRouteError(err, res);
  }
});

/** Delete an AI Provider (rejects with 409 if any agent_config references it). */
router.delete("/settings/ai-providers/:id", requireRole("admin"), (req, res) => {
  const existing = providerRouteRepo.getById(req.workspaceId, req.params.id);
  if (!existing) return res.status(404).json({ error: "AI provider not found" });
  const pinnedRoles = agentConfigRepo.listByWorkspace(req.workspaceId)
    .filter((c) => c.routeId === existing.id)
    .map((c) => c.role);
  if (pinnedRoles.length > 0) {
    return res.status(409).json({
      error: `AI provider is in use by agent role(s): ${pinnedRoles.join(", ")}. Reassign or clear those roles first.`,
      code: "ERR_ROUTE_IN_USE",
      pinnedRoles,
    });
  }
  const result = providerRouteRepo.remove(req.workspaceId, req.params.id, { userId: req.authUser?.sub || null });
  logActivity({ ...actor(req), type: "settings.update", detail: `AI Provider deleted: ${existing.name}` });
  res.json({ ok: true, ...result });
});

/** Probe an AI Provider (network reachability + auth + model check). */
router.post("/settings/ai-providers/:id/probe", requireRole("admin"), async (req, res) => {
  const updated = await providerRouteRepo.probeAndPersist(req.workspaceId, req.params.id, {
    userId: req.authUser?.sub || null,
  });
  if (!updated) return res.status(404).json({ error: "AI provider not found" });
  return res.json({ ok: true, route: toDisplayRoute(updated), capabilities: updated.capabilities });
});

/**
 * Migration 059 — pin / unpin the workspace-default AI Provider.
 *
 * This is the explicit operator surface for the "which provider handles
 * agent roles that have no per-role override?" question. Without a default
 * pinned, `resolveRoute` falls through to env-variable detection
 * (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc.), which is invisible to
 * operators looking only at the AI Providers UI.
 *
 * POST body: `{ default: true }` to pin THIS provider, `{ default: false }`
 * to clear the workspace's default entirely. Mutual exclusion (one default
 * per workspace) is enforced by the migration's partial UNIQUE index and
 * the repo's `setWorkspaceDefault` transaction.
 *
 * Dedicated endpoint rather than a PATCH field because:
 *   1. Setting a default has side effects on OTHER rows (clearing the
 *      previous default). Hiding that in a generic PATCH would surprise
 *      anyone reading the audit log.
 *   2. The audit entry needs a specific `metadata.changed:
 *      ["isWorkspaceDefault"]` shape so admins can filter for "who pinned
 *      the default and when?".
 */
router.post("/settings/ai-providers/:id/default", requireRole("admin"), (req, res) => {
  const existing = providerRouteRepo.getById(req.workspaceId, req.params.id);
  if (!existing) return res.status(404).json({ error: "AI provider not found" });
  const wantDefault = req.body?.default === true;
  try {
    const updated = providerRouteRepo.setWorkspaceDefault(
      req.workspaceId,
      wantDefault ? existing.id : null,
      { userId: req.authUser?.sub || null },
    );
    logActivity({
      ...actor(req), type: "settings.update",
      detail: wantDefault
        ? `AI Provider pinned as workspace default: ${existing.name}`
        : `AI Provider workspace default cleared`,
    });
    const rolesByRouteId = buildRolesByRouteId(req.workspaceId);
    res.json({ ok: true, route: updated ? toDisplayRoute(updated, rolesByRouteId) : null });
  } catch (err) {
    return handleProviderRouteError(err, res);
  }
});

/** Rotate API key for an AI Provider — identical logic to provider-routes rotate-key. */
router.post("/settings/ai-providers/:id/rotate-key", requireRole("admin"), async (req, res) => {
  // Re-use the original handler by rewriting the param and delegating to
  // the identically-scoped route. Express doesn't support router.dispatch
  // directly, so we replicate the thin validation + delegate pattern here.
  // The handler body is identical to /settings/provider-routes/:id/rotate-key.
  const existing = providerRouteRepo.getById(req.workspaceId, req.params.id);
  if (!existing) return res.status(404).json({ error: "AI provider not found" });
  const rawKey = (typeof req.body?.newApiKey === "string" && req.body.newApiKey)
    || (typeof req.body?.apiKey === "string" && req.body.apiKey)
    || "";
  const plaintext = rawKey.trim();
  if (!plaintext || plaintext.length < 10)
    return res.status(400).json({ error: "newApiKey is required and must be at least 10 characters" });
  const priorSecret = providerRouteRepo.getSecretById(req.workspaceId, existing.id);
  const enc = secrets.encryptKey(plaintext);
  try {
    providerRouteRepo.upsert({
      id: existing.id, workspaceId: req.workspaceId,
      userId: req.authUser?.sub || null,
      apiKeyEncrypted: enc.ciphertext, apiKeyNonce: enc.nonce, apiKeyLastFour: enc.lastFour,
      skipAutoProbe: true,
    });
    const probed = await providerRouteRepo.probeAndPersist(req.workspaceId, existing.id, {
      userId: req.authUser?.sub || null,
    });
    const caps = probed?.capabilities;
    const probeOk = caps && caps.reachable && caps.auth !== false && caps.model !== false;
    if (!probeOk) {
      providerRouteRepo.upsert({
        id: existing.id, workspaceId: req.workspaceId,
        userId: req.authUser?.sub || null,
        apiKeyEncrypted: priorSecret?.apiKeyEncrypted ?? null,
        apiKeyNonce: priorSecret?.apiKeyNonce ?? null,
        apiKeyLastFour: priorSecret?.apiKeyLastFour ?? null,
        capabilities: existing.capabilities ?? null,
        skipAutoProbe: true,
      });
      return res.status(400).json({
        error: "Probe failed — new key was rejected",
        reason: caps?.errorReason || "probe_failed",
        capabilities: caps,
      });
    }
    resetRouteBreakers(existing.id);
    logActivity({
      ...actor(req), type: "auth.api_key.rotate", req,
      workspaceId: req.workspaceId,
      meta: { routeId: existing.id, routeName: existing.name, lastFour: enc.lastFour },
    });
    res.json({ ok: true, lastFour: enc.lastFour, capabilities: caps });
  } catch (err) {
    return handleProviderRouteError(err, res);
  }
});

export default router;



