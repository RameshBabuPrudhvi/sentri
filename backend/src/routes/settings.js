/**
 * settings.js — Config & Settings routes
 *
 * Mounted at /api in index.js
 */

import { Router } from "express";
import { logActivity } from "../utils/activityLogger.js";
import { hasProvider, setRuntimeKey, setRuntimeOllama, checkOllamaConnection, getProviderMeta, getConfiguredKeys } from "../aiProvider.js";

const router = Router();

// GET /api/config — provider info for the LLM badge shown everywhere
router.get("/config", (req, res) => {
  const meta = getProviderMeta();
  res.json({
    provider: meta?.provider || null,
    providerName: meta?.name || "No provider configured",
    model: meta?.model || null,
    color: meta?.color || null,
    hasProvider: hasProvider(),
    supportedProviders: [
      { id: "anthropic", name: "Claude Sonnet",    model: "claude-sonnet-4-20250514", docsUrl: "https://console.anthropic.com/settings/keys" },
      { id: "openai",    name: "GPT-4o-mini",      model: "gpt-4o-mini",              docsUrl: "https://platform.openai.com/api-keys" },
      { id: "google",    name: "Gemini 2.5 Flash", model: "gemini-2.5-flash",         docsUrl: "https://aistudio.google.com/apikey" },
      { id: "local",     name: "Ollama (local)",   model: "llama3.2",                 docsUrl: "https://ollama.ai" },
    ],
  });
});

// GET /api/settings — returns masked key status (never full keys)
router.get("/settings", (req, res) => {
  res.json(getConfiguredKeys());
});

// POST /api/settings — save API key at runtime (no server restart needed)
router.post("/settings", (req, res) => {
  const { provider, apiKey, baseUrl, model } = req.body;
  const validProviders = ["anthropic", "openai", "google", "local"];

  if (!provider || !validProviders.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${validProviders.join(", ")}` });
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
    logActivity({ type: "settings.update", detail: "Ollama (local) provider configured" });
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

  logActivity({
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
router.delete("/settings/:provider", (req, res) => {
  const { provider } = req.params;

  if (provider === "local") {
    setRuntimeOllama({ baseUrl: "", model: "", disabled: true });
  } else {
    setRuntimeKey(provider, "");
  }

  logActivity({
    type: "settings.update",
    detail: `Provider "${provider}" deactivated`,
  });

  res.json({ ok: true });
});

// GET /api/ollama/status — check Ollama connectivity + list available models
router.get("/ollama/status", async (req, res) => {
  const status = await checkOllamaConnection();
  res.json(status);
});

export default router;
