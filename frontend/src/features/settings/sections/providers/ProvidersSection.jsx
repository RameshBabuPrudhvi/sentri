import React, { useCallback } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { api } from "../../../../api.js";
import { invalidateSettingsCache } from "../../../../queryClient.js";
import { useSettingsBundleQuery } from "../../../../hooks/queries/useSettingsQueries.js";
import { invalidateConfigCache } from "../../../../components/layout/ProviderBadge.jsx";
import { emitTourEvent } from "../../../../hooks/useOnboarding.js";
import ProviderCard from "./ProviderCard.jsx";
import CompatProviderForm from "./CompatProviderForm.jsx";
import { PROVIDERS } from "./providers.constants.js";

/**
 * AI Providers section. Cloud providers (Anthropic, OpenAI, Google,
 * OpenRouter) + local Ollama + OpenAI-compatible custom slots (AI-001).
 *
 * The active-provider banner reads from the settings bundle's `config` slice;
 * each ProviderCard reads its own slice (masked key, ollama base URL / model)
 * and renders its own form. Save / delete go through shared handlers that
 * invalidate both the config cache (badge re-fetches) and the settings
 * bundle (this section re-fetches the masked key + active provider).
 * Extracted from Settings.jsx (GAP-002).
 */
export default function ProvidersSection() {
  const bundleQuery = useSettingsBundleQuery();
  const settings = bundleQuery.data?.settings ?? null;
  const config   = bundleQuery.data?.config ?? null;
  const loading  = bundleQuery.isLoading;

  const reload = useCallback(() => invalidateSettingsCache(), []);

  async function handleSave(provider, apiKey, ollamaOpts) {
    await api.saveApiKey(provider, apiKey, ollamaOpts);
    invalidateConfigCache();
    await reload();
    emitTourEvent("provider-saved");
  }

  async function handleDelete(provider) {
    await api.deleteApiKey(provider);
    invalidateConfigCache();
    await reload();
  }

  return (
    <>
      {/* Active provider banner */}
      {!loading && config && (
        <div className={`st-provider-banner ${config.hasProvider ? "st-provider-banner--ok" : "st-provider-banner--missing"}`}>
          {config.hasProvider ? (
            <>
              <div className="st-active-dot" />
              <div>
                <div className="font-bold">Active: {config.providerName}</div>
                <div className="text-xs text-muted st-provider-banner__model">{config.model}</div>
              </div>
            </>
          ) : (
            <>
              <AlertTriangle size={18} color="var(--red)" />
              <div>
                <div className="st-provider-banner__title-missing">No AI provider configured</div>
                <div className="text-xs text-muted">
                  Add an API key below, or activate Ollama for 100% local inference
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Provider cards */}
      {loading ? (
        <div className="st-provider-loading-grid">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton st-provider-skeleton" />)}
        </div>
      ) : (
        <div className="st-provider-cards">
          {PROVIDERS.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              activeProvider={settings?.activeProvider}
              maskedKey={settings?.[p.id]}
              ollamaBaseUrl={settings?.ollamaBaseUrl}
              ollamaModel={settings?.ollamaModel}
              onSave={handleSave}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      <CompatProviderForm
        compatProviders={settings?.compatProviders}
        reload={reload}
        onDelete={handleDelete}
      />

      {/* Persistence note — UX-AUDIT (May 2026): moved to the bottom of the
          providers section so it reads as a closing footer note covering
          BOTH the built-in provider cards above AND the compat slots. The
          previous mid-page placement (between built-ins and compat) made
          the note look like it only applied to the built-in cards and
          visually disowned the compat section. Mirrors the disclaimer
          placement on Stripe's "Developers → API keys" page. */}
      <div className="st-env-tip">
        <div className="st-env-tip__row">
          <Info size={13} className="shrink-0 st-env-tip__icon" />
          <div className="text-sm text-sub st-env-tip__body">
            Keys saved here are stored in memory and will reset when the server restarts.
            For persistent configuration, see the deployment documentation.
          </div>
        </div>
      </div>
    </>
  );
}
