import React, { lazy, Suspense } from "react";
import { Navigate, Route } from "react-router-dom";
import PageSkeleton from "../../components/layout/PageSkeleton.jsx";
import { useSettingsSections } from "./hooks/useSettingsSections.js";

/**
 * Index-route redirect for `/settings`. Resolves the role-aware fallback
 * (admins → `providers`, non-admins → `execution`) at render time so admins
 * don't transit through `execution` first and trigger a double navigation.
 * Lives at the route layer rather than in `SettingsLayout`'s `useEffect` so
 * the redirect fires synchronously on first paint, eliminating the
 * empty-Outlet flash that prompted the original index-route addition.
 */
function SettingsIndexRedirect() {
  const { fallback } = useSettingsSections();
  return <Navigate to={fallback} replace />;
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
