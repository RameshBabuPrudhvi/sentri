// GAP-002 — Providers section. The Providers tab is the largest and densest
// surface in the old Settings.jsx god-file (cloud + OpenAI-compat + Ollama
// status panel = ~470 lines including ProviderCard). Extracting it safely
// requires verbatim transcription of inline-style refactors that risk
// silently breaking the most-used admin surface (where API keys are set).
//
// Phase 1 — keep the existing implementation sourced from `LegacySettings`
// (the renamed `pages/Settings.jsx`) and render its providers tab via the
// `legacyTab="providers"` prop. The URL contract, sidebar, lazy chunk
// boundary, and all section infrastructure ship in this PR — only the
// physical decomposition of these two surfaces is deferred to GAP-002b.
//
// This is the industry-standard god-file rollout pattern: ship the shell +
// contract first, extract internals incrementally with `npm run build` +
// real test runs gating each move.
import React from "react";
import LegacySettings from "../../../../pages/Settings.jsx";

export default function ProvidersSection() {
  return <LegacySettings legacyTab="providers" />;
}
