import React from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import usePageTitle from "../../hooks/usePageTitle.js";
import SettingsSidebar from "./SettingsSidebar.jsx";
import AdminLockedSection from "./shared/AdminLockedSection.jsx";
import { useSettingsSections, SETTINGS_SECTIONS } from "./hooks/useSettingsSections.js";
import { useAuth } from "../../context/AuthContext.jsx";

/**
 * Settings layout shell (GAP-002) — header + back button + sticky sidebar +
 * `<Outlet />` content area + restart-tour card. The industry-standard left-rail
 * layout used by GitHub Settings / Vercel / Linear / Sentry: each section gets
 * a bookmarkable URL, browser back/forward navigates between sections, and the
 * sidebar `<NavLink>` lights up via `aria-current="page"`.
 *
 * Redirect logic (legacy `?tab=<key>` rewrite for MfaGraceBanner + GitHub App
 * install callback, plus role-aware fallback for bare `/settings`) lives in
 * `SettingsIndexRedirect` at the route layer (`routes.jsx`). Synchronous on
 * first paint — no empty-Outlet flash, no race between competing effects.
 *
 * Per-section role gating runs here as a defence-in-depth UI gate; the backend
 * still enforces `requireRole()` on every mutation route.
 */
export default function SettingsLayout() {
  usePageTitle("Settings");
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const { user } = useAuth();
  const { fallback, isAdmin } = useSettingsSections();

  // React Router v6/v7: when `/settings/members` matches the parent route
  // `<Route path="/settings">` + child `<Route path="members">`, the parent's
  // `useParams()` does NOT contain `:section` — the dynamic segment lives on
  // the child. Extract the section from the pathname instead so the layout
  // shell always knows which section is active for role-gating + redirects.
  const pathSegments = location.pathname.split("/").filter(Boolean);
  const sectionParam = pathSegments[0] === "settings" ? pathSegments[1] || null : params.section || null;
  const activeSection = sectionParam
    ? SETTINGS_SECTIONS.find((s) => s.key === sectionParam) || null
    : null;
  const blockedByRole = activeSection?.adminOnly && !isAdmin;

  // Note: redirect logic (legacy `?tab=<key>` rewrite + bare-`/settings`
  // → role-aware fallback) lives in `SettingsIndexRedirect` at the route
  // layer (`routes.jsx`) — synchronous, no empty-Outlet flash, no race
  // between two competing effects. The two `useEffect`s that previously
  // lived here are intentionally gone; do not re-add them.

  return (
    <div className="fade-in page-container-xl">
      <button className="btn btn-ghost btn-sm settings-back" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>

      <div className="settings-header">
        <h1 className="settings-header__title">Settings</h1>
        <p className="settings-header__sub">
          Configure AI providers, execution defaults, and manage data.
        </p>
      </div>

      <div className="settings-shell">
        <SettingsSidebar />
        <div className="settings-main">
          {blockedByRole ? (
            <AdminLockedSection
              feature={activeSection.label}
              role={user?.workspaceRole}
            />
          ) : (
            <Outlet />
          )}

          {/* UX-AUDIT (May 2026): the "Getting Started Tour" card was
              previously rendered here on EVERY settings section (9 places)
              — visual noise after first-time onboarding. Moved into the
              Account section's `RestartTourCard` so it lives in exactly
              one place, alongside other personal preferences. Industry
              precedent: GitHub Settings → Account, Vercel Account,
              Linear Account → "Restart onboarding". */}
        </div>
      </div>
    </div>
  );
}
