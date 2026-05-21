import React, { useEffect } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Compass, RefreshCw } from "lucide-react";
import usePageTitle from "../../hooks/usePageTitle.js";
import { resetOnboarding } from "../../hooks/useOnboarding.js";
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
 * Legacy `?tab=<key>` URLs (MfaGraceBanner, GitHub App install callback) are
 * preserved as a one-shot redirect to the canonical `/settings/<key>` form so
 * existing deep links keep working without coordinated cross-file edits.
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

  // Back-compat: `?tab=<key>` → `/settings/<key>`, preserving sibling query
  // params (e.g. `github=installed` for the GitHub App install callback).
  useEffect(() => {
    const search = new URLSearchParams(location.search);
    const legacyTab = search.get("tab");
    if (!legacyTab) return;
    if (!SETTINGS_SECTIONS.some((s) => s.key === legacyTab)) return;
    search.delete("tab");
    const qs = search.toString();
    navigate(`/settings/${legacyTab}${qs ? `?${qs}` : ""}`, { replace: true });
  }, [location.search, navigate]);

  // Sidebar nav still points at `/settings` (no section). Redirect to the
  // first visible section so the URL is always canonical.
  useEffect(() => {
    if (sectionParam) return;
    if (!location.search.includes("tab=")) {
      navigate(`/settings/${fallback}`, { replace: true });
    }
  }, [sectionParam, fallback, navigate, location.search]);

  return (
    <div className="fade-in page-container-md">
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

          {/* Restart onboarding tour — shown on every section so the entry
              point is consistent regardless of which section the user is on. */}
          <div className="st-tour-card">
            <div className="st-section-icon icon-box-accent shrink-0">
              <Compass size={16} color="var(--accent)" />
            </div>
            <div className="flex-1">
              <div className="font-bold">Getting Started Tour</div>
              <div className="text-xs text-muted">
                Re-run the onboarding walkthrough that guides you through setup.
              </div>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                resetOnboarding();
                // Navigate away first (avoids beforeunload prompt from unsaved
                // API key inputs in providers section), then reload so
                // useOnboarding picks up the force flag on fresh mount.
                window.location.href = import.meta.env.BASE_URL + "dashboard";
              }}
            >
              <RefreshCw size={13} /> Restart Tour
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
