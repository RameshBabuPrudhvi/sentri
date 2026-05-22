import React, { lazy, Suspense } from "react";
import { Navigate, Route, useLocation } from "react-router-dom";
import PageSkeleton from "../../components/layout/PageSkeleton.jsx";
import { useSettingsSections, SETTINGS_SECTIONS } from "./hooks/useSettingsSections.js";

/**
 * Index-route redirect for `/settings`. The single canonical redirect surface
 * for bare-settings navigation — handles both:
 *
 *   1. Legacy `/settings?tab=<key>` deep links (MfaGraceBanner, GitHub App
 *      install callback) → rewrite to `/settings/<key>` while preserving
 *      sibling query params (e.g. `?github=installed`).
 *   2. Bare `/settings` (no tab, no section) → role-aware fallback section
 *      (admins → `providers`, non-admins → `execution`).
 *
 * Lives at the route layer rather than in `SettingsLayout`'s `useEffect` so
 * the redirect fires synchronously on first paint — no empty-Outlet flash,
 * no race between two effects fighting over the same path. Replaces the two
 * `useEffect`s previously in `SettingsLayout.jsx` (one for tab rewrite, one
 * for fallback). Both effects had bugs: the fallback one dropped sibling
 * query params, and the two could race on `/settings?foo=bar` where neither
 * predicate matched cleanly.
 */
function SettingsIndexRedirect() {
  const { fallback } = useSettingsSections();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const legacyTab = search.get("tab");

  // Branch 1: legacy `?tab=<key>` with a recognised section key. Strip the
  // tab param and forward the rest so callers that pass `?tab=integrations&github=installed`
  // keep their post-install signal.
  if (legacyTab && SETTINGS_SECTIONS.some((s) => s.key === legacyTab)) {
    search.delete("tab");
    const qs = search.toString();
    return <Navigate to={`/settings/${legacyTab}${qs ? `?${qs}` : ""}`} replace />;
  }

  // Branch 2: bare `/settings` (or `/settings?tab=garbage`) → role-aware
  // fallback, preserving any sibling query params the caller threaded
  // through (analytics tags, future state, etc.).
  const qs = location.search;
  return <Navigate to={`/settings/${fallback}${qs}`} replace />;
}

/**
 * Settings child routes (GAP-002). Each section is a lazy chunk so the
 * Settings bundle only ships the section the user navigated to — the
 * audit's P0 recommendation for the 3,595-line god-file. Future settings
 * additions edit this file plus add their own section folder; App.jsx
 * never needs to change.
 *
 * The two largest tabs (`providers`, `provider_routes`) defer their
 * internal decomposition to GAP-002b — they currently render via a thin
 * wrapper around the legacy Settings.jsx component, but they ship with
 * the same URL contract, lazy boundary, and sidebar wayfinding as the
 * fully-extracted sections.
 */
const ProvidersSection      = lazy(() => import("./sections/providers/ProvidersSection.jsx"));
const ProviderRoutesSection = lazy(() => import("./sections/provider-routes/ProviderRoutesSection.jsx"));
const AgentRolesSection     = lazy(() => import("./sections/agent-roles/AgentRolesSection.jsx"));
const MembersSection        = lazy(() => import("./sections/members/MembersSection.jsx"));
const ExecutionSection      = lazy(() => import("./sections/execution/ExecutionSection.jsx"));
const IntegrationsSection   = lazy(() => import("./sections/integrations/IntegrationsSection.jsx"));
const DataSection           = lazy(() => import("./sections/data/DataSection.jsx"));
const SecuritySection       = lazy(() => import("./sections/security/SecuritySection.jsx"));
const AccountSection        = lazy(() => import("./sections/account/AccountSection.jsx"));

function withSuspense(Component) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Component />
    </Suspense>
  );
}

/**
 * Child route definitions for the Settings parent route in App.jsx. Renders
 * inside SettingsLayout's `<Outlet />`. The index route delegates to
 * `SettingsIndexRedirect` so the fallback section is role-aware: admins land
 * on `providers`, non-admins on `execution`. Synchronous redirect on first
 * paint — no empty-Outlet flash.
 */
export const settingsRoutes = (
  <>
    <Route index element={<SettingsIndexRedirect />} />
    <Route path="providers"       element={withSuspense(ProvidersSection)} />
    <Route path="provider_routes" element={withSuspense(ProviderRoutesSection)} />
    <Route path="agent_roles"     element={withSuspense(AgentRolesSection)} />
    <Route path="members"         element={withSuspense(MembersSection)} />
    <Route path="execution"       element={withSuspense(ExecutionSection)} />
    <Route path="integrations"    element={withSuspense(IntegrationsSection)} />
    <Route path="data"            element={withSuspense(DataSection)} />
    <Route path="security"        element={withSuspense(SecuritySection)} />
    <Route path="account"         element={withSuspense(AccountSection)} />
  </>
);
