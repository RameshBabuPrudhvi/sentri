import { getProviderMeta, getSupportedProviders } from "./index.js";

export function getModelCatalog() {
  const meta = getProviderMeta();
  return Object.entries(meta).reduce((acc, [provider, value]) => {
    acc[provider] = {
      model: value.model,
      name: value.name,
      supportsVision: provider === "openai" || provider === "google" || provider === "anthropic" || provider.startsWith("compat:"),
      supportsJsonMode: provider !== "ollama",
      contextWindow: null,
    };
    return acc;
  }, {});
}

export { getSupportedProviders };
