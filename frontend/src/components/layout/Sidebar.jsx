import React, { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Home, FolderKanban, SquareCheckBig, PlayCircle, BarChart3, Bot, Server,
    Settings, ChevronDown, Check, ChevronRight, PanelLeftClose, PanelLeftOpen,
    Atom,
} from "lucide-react";
import AppLogo from "./AppLogo.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { userHasRole } from "../../utils/roles.js";
import { api } from "../../api.js";

const NAV_GROUPS = [
  {
    label: "Core",
    items: [
      { to: "/dashboard", icon: Home, label: "Dashboard", tour: "tour-dashboard" },
      { to: "/projects",  icon: FolderKanban, label: "Projects",  tour: "tour-projects" },
      { to: "/tests",     icon: SquareCheckBig, label: "Tests", tour: "tour-tests" },
      { to: "/test-lab",  icon: Atom, label: "Test Lab" },
    ],
  },
  {
    label: "Activity",
    items: [
      { to: "/runs",    icon: PlayCircle, label: "Runs" },
      { to: "/reports", icon: BarChart3, label: "Reports" },
    ],
  },
  {
    label: "Automation",
    items: [
      { to: "/automation", icon: Bot, label: "Automation" },
      { to: "/system",     icon: Server, label: "System" },
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
          {NAV_GROUPS.flatMap(group => group.items).map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className="nav-link sidebar-rail__nav-item"
              data-tour={item.tour || undefined}
              title={item.label}
            >
              {({ isActive }) => (
                <item.icon size={18} strokeWidth={isActive ? 2.4 : 1.6} />
              )}
            </NavLink>
          ))}
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
              {group.items.map(item => (
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
              ))}
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