import React, { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, FlaskConical, FolderOpen, BarChart2, Briefcase, Layers, Zap, Settings, ChevronDown, Check } from "lucide-react";
import AppLogo from "./AppLogo.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { userHasRole } from "../../utils/roles.js";
import { api } from "../../api.js";

const NAV = [
  // ── Core ──
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard", tour: "tour-dashboard" },
  { to: "/projects",  icon: FolderOpen,      label: "Projects",  tour: "tour-projects"  },
  { to: "/tests",     icon: FlaskConical,    label: "Tests",     tour: "tour-tests"     },
  // ── Activity ──
  { separator: true },
  { to: "/runs",      icon: Briefcase,       label: "Runs"      },
  { to: "/reports",   icon: BarChart2,       label: "Reports"   },
  // ── Automation ──
  { separator: true },
  { to: "/automation", icon: Zap,             label: "Automation" },
  { to: "/system",    icon: Layers,          label: "System"    },
];

export default function Sidebar({ open }) {
  const { user, login } = useAuth();
  const isAdmin = userHasRole(user, "admin");
  const navigate = useNavigate();
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const hasMultipleWorkspaces = user?.workspaces?.length > 1;

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

  return (
    <aside className={open ? "sidebar-open" : ""} style={{
      width: 192, background: "var(--surface)", borderRight: "1px solid var(--border)",
      display: "flex", flexDirection: "column", flexShrink: 0,
      position: "sticky", top: 0, height: "100vh", overflowY: "auto",
    }}>
      {/* Logo */}
      <div style={{ padding: "16px 16px 14px", borderBottom: "1px solid var(--border)" }}>
        <AppLogo size={30} variant="full" />
      </div>

      {/* Workspace switcher (ACL-001) */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", position: "relative" }}>
          <button
            onClick={() => hasMultipleWorkspaces && setWsMenuOpen(o => !o)}
            style={{
              display: "flex", alignItems: "center", gap: 6, width: "100%",
              padding: "6px 8px", borderRadius: "var(--radius)", border: "none",
              background: wsMenuOpen ? "var(--bg2)" : "transparent",
              cursor: hasMultipleWorkspaces ? "pointer" : "default",
              textAlign: "left", transition: "background 0.12s",
            }}
            onMouseEnter={e => { if (hasMultipleWorkspaces) e.currentTarget.style.background = "var(--bg2)"; }}
            onMouseLeave={e => { if (!wsMenuOpen) e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user?.workspaceName || "My Workspace"}
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--text3)", textTransform: "capitalize" }}>
                {user?.workspaceRole || "Personal"}
              </div>
            </div>
            {hasMultipleWorkspaces && (
              <ChevronDown size={12} color="var(--text3)" style={{ flexShrink: 0, transition: "transform 0.15s", transform: wsMenuOpen ? "rotate(180deg)" : "none" }} />
            )}
        </button>

        {/* Dropdown menu */}
        {wsMenuOpen && hasMultipleWorkspaces && (
          <div style={{
            position: "absolute", left: 8, right: 8, top: "100%", zIndex: 50,
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", boxShadow: "var(--shadow)",
            padding: "4px 0", marginTop: 4, maxHeight: 200, overflowY: "auto",
          }}>
            {user.workspaces.map(ws => {
              const isCurrent = ws.id === user.workspaceId;
              return (
                <button
                  key={ws.id}
                  onClick={() => handleSwitchWorkspace(ws.id)}
                  disabled={switching}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%",
                    padding: "7px 10px", border: "none", borderRadius: 0,
                    background: isCurrent ? "var(--accent-bg)" : "transparent",
                    cursor: isCurrent ? "default" : "pointer",
                    textAlign: "left", fontSize: "0.78rem", color: "var(--text)",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = "var(--bg2)"; }}
                  onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}
                ><div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: isCurrent ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ws.name}
                    </div>
                    <div style={{ fontSize: "0.65rem", color: "var(--text3)", textTransform: "capitalize" }}>
                      {ws.role}{ws.isOwner ? " · Owner" : ""}
                    </div>
                  </div>
                  {isCurrent && <Check size={12} color="var(--accent)" style={{ flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={{ padding: "10px 8px", flex: 1 }}>
        {NAV.map((item, i) => item.separator ? (
          <div key={`sep-${i}`} style={{ height: 1, background: "var(--border)", margin: "6px 10px" }} />
        ) : (
          <NavLink key={item.to} to={item.to} className="nav-link" data-tour={item.tour || undefined} style={({ isActive }) => ({
            display: "flex", alignItems: "center", gap: 9, padding: "7px 10px",
            borderRadius: "var(--radius)", marginBottom: 1,
            fontWeight: isActive ? 600 : 400, fontSize: "0.875rem",
            color: isActive ? "var(--accent)" : "var(--text2)",
            background: isActive ? "var(--accent-bg)" : "transparent",
            textDecoration: "none", transition: "all 0.12s",
          })}>
            <item.icon size={16} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Settings (admin only) */}
      {isAdmin && (
      <div style={{ padding: "10px 8px", borderTop: "1px solid var(--border)" }}>
        <NavLink to="/settings" className="nav-link" data-tour="tour-settings" style={({ isActive }) => ({
          display: "flex", alignItems: "center", gap: 9, padding: "7px 10px",
          borderRadius: "var(--radius)", fontWeight: isActive ? 600 : 400,
          fontSize: "0.875rem", color: isActive ? "var(--accent)" : "var(--text2)",
          background: isActive ? "var(--accent-bg)" : "transparent",
          textDecoration: "none",
        })}>
          <Settings size={16} />Settings
        </NavLink>
      </div>
      )}
    </aside>
  );
}
