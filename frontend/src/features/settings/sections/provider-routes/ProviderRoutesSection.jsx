// GAP-002 — Provider Routes section. The largest single subtree in the
// old Settings.jsx god-file (~1,200 lines: ProviderRoutesTab,
// ProviderRoutesTabView, ProviderRoutesForm, ProviderRouteRow, ProbeBadge,
// WorkspaceSpendCapsPanel, ProviderRoutesIO, AuditLogSubtab,
// AiRequestLogSubtab + 50+ inline-style call sites). Extracting it safely
// requires per-component CSS-class refactors that risk silently breaking
// the AI-routes operator surface where keys are rotated and spend caps
// are set.
//
// Phase 1 ships the URL + sidebar + layout shell + lazy-chunk boundary;
// the physical extraction of this subtree is tracked as GAP-002b. The
// section renders via the legacy implementation behind the same
// `/settings/provider_routes` URL — operator-visible behaviour is
// identical to today, only the URL is now canonical and bookmarkable.
import React from "react";
import LegacySettings from "../../../../pages/Settings.jsx";

export default function ProviderRoutesSection() {
  return <LegacySettings legacyTab="provider_routes" />;
}
