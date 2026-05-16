import React, { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Home, FolderKanban, SquareCheckBig, PlayCircle, BarChart3, Bot, Server,
    Settings, ChevronDown, Check, ChevronRight, PanelLeftClose, PanelLeftOpen,
    Atom, Shield, ClipboardCheck, ScrollText,
} from "lucide-react";
import AppLogo from "./AppLogo.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { userHasRole } from "../../utils/roles.js";
import { api } from "../../api.js";
import useAutoApprovalsQuery from "../../hooks/queries/useAutoApprovalsQuery.js";

// Review Queue intentionally has no sidebar entry — it's reached via the
// "Review Drafts" quick-action card on the Tests page (`Tests.jsx`), which
// carries the live draft count and project-scoped deep-link. Adding a
// sidebar entry here would duplicate that surface; the `/review-queue`
// route itself remains registered in `App.jsx` for the card's navigate().
const NAV_GROUPS = [
  {
    label: "Core",
    items: [
      { to: "/dashboard",     icon: Home,          label: "Dashboard",     tour: "tour-dashboard" },
      { to: "/projects",      icon: FolderKanban,  label: "Projects",      tour: "tour-projects"  },
      { to: "/tests",         icon: SquareCheckBig,label: "Tests",         tour: "tour-tests"     },
      { to: "/test-lab",      icon: Atom,          label: "Test Lab"                              },
    ],
  },
  {
    label: "Activity",
    items: [
      { to: "/runs",    icon: PlayCircle, label: "Runs"    },
      { to: "/reports", icon: BarChart3,  label: "Reports" },
    ],
  },
  {
    label: "Automation",
    items: [
      { to: "/automation", icon: Bot,    label: "Automation" },
      { to: "/approvals",  icon: ClipboardCheck, label: "Approvals" },
      { to: "/healing", icon: Shield, label: "Healing" },
      { to: "/audit-log",  icon: ScrollText,     label: "Audit log" },
      { to: "/system",     icon: Server, label: "System"     },
    ],
  },
];

/**
 * Tiny coloured avatar generated from workspace initials.
 * Only the hue-derived palette stays inline — everything else is in
 * `styles/features/sidebar.css` under `.workspace-avatar`.
 */
function WorkspaceAvatar({ name }) {
  const initials = (name || "W")
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0])
    .join("")
    .toUpperCase();

  const hue = Array.from(name || "W").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;

  return (
    <span
      className="workspace-avatar"
      style={{
        background: `hsl(${hue},50%,88%)`,
        color: `hsl(${hue},55%,32%)`,
        border: `1px solid hsl(${hue},40%,80%)`,
      }}
    >
      {initials}
    </span>
  );
}

export default function Sidebar({ open, collapsed = false, onToggleCollapsed }) {
  const { user, login } = useAuth();
  const isAdmin = userHasRole(user, "admin");
  const navigate = useNavigate();
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const hasMultipleWorkspaces = user?.workspaces?.length > 1;

  // ── AUTO-003b: live "🤖 N auto today" badge on the Approvals nav entry ────
  // NEXT.md:97 lists this badge as an acceptance criterion (and "hiding the
  // auto-count from the sidebar" as a rejection criterion). The count is
  // workspace-scoped `test.auto_approve` activity rows since local-midnight.
  // Today, not 24h, because the badge reads as "today's auto-approvals" —
  // a reviewer arriving in the morning wants to see what fired overnight.
  //
  // Uses the shared `useAutoApprovalsQuery` hook (TanStack Query) so the
  // same cache powers the ReviewQueue tray; mounting both surfaces at once
  // is still one network request, and revoke mutations bust both via
  // `invalidateAutoApprovalsCache()`. Fetches once on mount, refreshes on
  // window-focus + every 60s as a safety net, fails silently (badge just
  // doesn't render on error).
  const autoTodayQuery = useAutoApprovalsQuery({ scope: "today" });
  const autoTodayCount = (autoTodayQuery.data || []).length;

  // Force-expand the dropdown closed when the sidebar collapses to a rail —
  // the dropdown is anchored to the wide-mode workspace switcher and would
  // float into the main content area otherwise.
  React.useEffect(() => { if (collapsed) setWsMenuOpen(false); }, [collapsed]);

  async function handleSwitchWorkspace(workspaceId) {
    if (workspaceId === user?.workspaceId || switching) return;
    setSwitching(true);
    try {
      const { user: updated } = await api.switchWorkspace(workspaceId);
      login(updated);
      setWsMenuOpen(false);
      navigate("/dashboard");
    } catch (err) {
      console.error("Workspace switch failed:", err);
    } finally {
      setSwitching(false);
    }
  }

  // ── Collapsed rail (Collabplace-style) ────────────────────────────────────
  // Renders only logo + nav icons + settings icon at 64px width. Tooltips via
  // the native `title` attribute keep this dependency-free.
  if (collapsed) {
    const asideClass = `sidebar sidebar--collapsed${open ? " sidebar-open" : ""}`;
    return (
      <aside className={asideClass}>
        {/* Logo — doubles as expand toggle in collapsed mode so the toggle
            lives in the same place (top) as the collapse toggle in expanded
            mode, avoiding the footer/header asymmetry. */}
        <button
          className="sidebar-rail__logo-btn"
          onClick={() => onToggleCollapsed?.()}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <AppLogo size={28} variant="icon" />
        </button>

        {/* Workspace avatar (clicking expands the sidebar so the user can switch) */}
        <div className="sidebar-rail__workspace">
          <button
            className="sidebar-rail__workspace-btn"
            onClick={() => onToggleCollapsed?.()}
            title={user?.workspaceName || "My Workspace"}
          >
            <WorkspaceAvatar name={user?.workspaceName || "My Workspace"} />
          </button>
        </div>

        {/* Nav icons */}
        <nav className="sidebar-rail__nav">
          {NAV_GROUPS.flatMap(group => group.items).map(item => {
            // AUTO-003b: rail-mode equivalent of the expanded "🤖 N" badge —
            // a small dot in the corner of the Approvals icon when there's
            // unreviewed auto-approval activity today. The full count
            // surfaces in the tooltip (`title`) so users on the rail can
            // still see the magnitude without expanding.
            const showAutoDot = item.to === "/approvals" && autoTodayCount > 0;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className="nav-link sidebar-rail__nav-item"
                data-tour={item.tour || undefined}
                title={showAutoDot
                  ? `${item.label} — ${autoTodayCount} auto-approved today`
                  : item.label}
              >
                {({ isActive }) => (
                  <>
                    <item.icon size={18} strokeWidth={isActive ? 2.4 : 1.6} />
                    {showAutoDot && (
                      <span
                        className="sidebar-rail__nav-dot"
                        aria-label={`${autoTodayCount} auto-approved today`}
                      />
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Footer: settings (admin only) — expand toggle lives at the top
            on the logo, matching the expanded-mode collapse-toggle position. */}
        {isAdmin && (
          <div className="sidebar-rail__footer">
            <NavLink
              to="/settings"
              className="nav-link sidebar-rail__footer-link"
              data-tour="tour-settings"
              title="Settings"
            >
              <Settings size={16} strokeWidth={1.8} />
            </NavLink>
          </div>
        )}
      </aside>
    );
  }

  // ── Expanded sidebar (default) ────────────────────────────────────────────
  const asideClass = `sidebar sidebar--expanded${open ? " sidebar-open" : ""}`;
  return (
    <aside className={asideClass}>
      {/* ── Logo + collapse toggle ── */}
      <div className="sidebar-header">
        <AppLogo size={28} variant="full" />
        <button
          className="sidebar-header__collapse-btn"
          onClick={() => onToggleCollapsed?.()}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      {/* ── Workspace Switcher ── */}
      <div className="workspace-switcher">
        <button
          className={`workspace-switcher__btn ${hasMultipleWorkspaces ? "workspace-switcher__btn--clickable" : "workspace-switcher__btn--readonly"}${wsMenuOpen ? " workspace-switcher__btn--open" : ""}`}
          onClick={() => hasMultipleWorkspaces && setWsMenuOpen(o => !o)}
        >
          <WorkspaceAvatar name={user?.workspaceName || "My Workspace"} />
          <div className="workspace-switcher__meta">
            <div className="workspace-switcher__name">
              {user?.workspaceName || "My Workspace"}
            </div>
            <div className="workspace-switcher__role">
              {user?.workspaceRole || "Personal"}
            </div>
          </div>
          {hasMultipleWorkspaces && (
            <ChevronDown
              size={13}
              color="var(--text3)"
              className={`workspace-switcher__chevron${wsMenuOpen ? " workspace-switcher__chevron--open" : ""}`}
            />
          )}
        </button>

        {/* Workspace dropdown */}
        {wsMenuOpen && hasMultipleWorkspaces && (
          <div className="workspace-dropdown">
            {user.workspaces.map(ws => {
              const isCurrent = ws.id === user.workspaceId;
              return (
                <button
                  key={ws.id}
                  className={`workspace-dropdown__item${isCurrent ? " workspace-dropdown__item--current" : ""}`}
                  onClick={() => handleSwitchWorkspace(ws.id)}
                  disabled={switching}
                >
                  <WorkspaceAvatar name={ws.name} />
                  <div className="workspace-dropdown__meta">
                    <div className={`workspace-dropdown__name${isCurrent ? " workspace-dropdown__name--current" : ""}`}>
                      {ws.name}
                    </div>
                    <div className="workspace-dropdown__role">
                      {ws.role}{ws.isOwner ? " · Owner" : ""}
                    </div>
                  </div>
                  {isCurrent && <Check size={13} color="var(--accent)" style={{ flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Nav groups ── */}
      <nav className="sidebar-nav">
        {NAV_GROUPS.map(group => (
          <div key={group.label}>
            <div className="sidebar-nav__group-label">{group.label}</div>
            <div className="sidebar-nav__group-items">
              {group.items.map(item => {
                // AUTO-003b: live count of auto-approvals fired today on
                // the Approvals entry. Rendered as a compact pill before
                // the active-route chevron so it stays visible regardless
                // of which page the user is on. Suppressed when zero —
                // an empty badge is visual noise.
                const showAutoBadge = item.to === "/approvals" && autoTodayCount > 0;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className="nav-link sidebar-nav__item"
                    data-tour={item.tour || undefined}
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon
                          size={16}
                          className="sidebar-nav__item-icon"
                          strokeWidth={isActive ? 2.4 : 1.6}
                        />
                        <span>{item.label}</span>
                        {showAutoBadge && (
                          <span
                            className="sidebar-nav__auto-badge"
                            title={`${autoTodayCount} test${autoTodayCount === 1 ? "" : "s"} auto-approved today`}
                            aria-label={`${autoTodayCount} auto-approved today`}
                          >
                            🤖 {autoTodayCount}
                          </span>
                        )}
                        {isActive && (
                          <ChevronRight
                            size={12}
                            className="sidebar-nav__item-chevron"
                            color="var(--accent)"
                          />
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Settings footer (admin only) ── */}
      {isAdmin && (
        <div className="sidebar-footer">
          <NavLink
            to="/settings"
            className="nav-link sidebar-footer__link"
            data-tour="tour-settings"
          >
            <Settings size={15} strokeWidth={1.8} />
            <span>Settings</span>
          </NavLink>
        </div>
      )}
    </aside>
  );
}