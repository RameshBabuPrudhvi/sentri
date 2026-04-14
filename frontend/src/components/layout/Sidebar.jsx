import React from "react";
import { NavLink } from "react-router-dom";
import { LayoutDashboard, FlaskConical, FolderOpen, BarChart2, Briefcase, Layers, Settings, BookOpen, ExternalLink, MessageSquare } from "lucide-react";
import AppLogo from "./AppLogo.jsx";

const NAV = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard", tour: "tour-dashboard" },
  { to: "/projects",  icon: FolderOpen,      label: "Projects",  tour: "tour-projects"  },
  { to: "/tests",     icon: FlaskConical,    label: "Tests",     tour: "tour-tests"     },
  { to: "/reports",   icon: BarChart2,       label: "Reports"   },
  { to: "/runs",      icon: Briefcase,       label: "Runs"      },
  { to: "/system",    icon: Layers,          label: "System"    },
  { to: "/chat",      icon: MessageSquare,   label: "AI Chat"   },
];

export default function Sidebar({ open }) {
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

      {/* Workspace — no interactive styling until feature exists (Fix #16) */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ padding: "6px 8px", borderRadius: "var(--radius)" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text)" }}>My Workspace</div>
          <div style={{ fontSize: "0.7rem", color: "var(--text3)" }}>Personal</div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ padding: "10px 8px", flex: 1 }}>
        {NAV.map(({ to, icon: Icon, label, tour }) => (
          <NavLink key={to} to={to} className="nav-link" data-tour={tour || undefined} style={({ isActive }) => ({
            display: "flex", alignItems: "center", gap: 9, padding: "7px 10px",
            borderRadius: "var(--radius)", marginBottom: 1,
            fontWeight: isActive ? 600 : 400, fontSize: "0.875rem",
            color: isActive ? "var(--accent)" : "var(--text2)",
            background: isActive ? "var(--accent-bg)" : "transparent",
            textDecoration: "none", transition: "all 0.12s",
          })}>
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Settings + Docs at bottom */}
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
        <a href={`${import.meta.env.BASE_URL}docs/`} target="_blank" rel="noopener noreferrer" style={{
          display: "flex", alignItems: "center", gap: 9, padding: "7px 10px",
          borderRadius: "var(--radius)", fontSize: "0.875rem", color: "var(--text2)",
          textDecoration: "none", transition: "all 0.12s", marginTop: 1,
        }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--bg2)"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
        >
          <BookOpen size={16} />Docs
          <ExternalLink size={11} style={{ marginLeft: "auto", opacity: 0.4 }} />
        </a>
      </div>
    </aside>
  );
}
