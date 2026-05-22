import React, { lazy, Suspense } from "react";
import { Navigate, Route } from "react-router-dom";
import PageSkeleton from "../../components/layout/PageSkeleton.jsx";

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
 * inside SettingsLayout's `<Outlet />`. The index route redirects to the
 * `execution` section — the only section every role can view, so the
 * fallback never lands a non-admin on an admin-locked surface.
 * SettingsLayout still runs a role-aware redirect on top of this for admins
 * who should land on `providers`, but the index Navigate eliminates the
 * empty-Outlet flash on the first paint of `/settings`.
 */
export const settingsRoutes = (
  <>
    <Route index element={<Navigate to="execution" replace />} />
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
