import React from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, FlaskConical, FolderOpen, BarChart2, Briefcase, Layers, Settings, Plus, Search } from "lucide-react";
import ProviderBadge from "./ProviderBadge.jsx";

const NAV = [
  { to: "/dashboard",    icon: LayoutDashboard, label: "Dashboard" },
  { to: "/projects",     icon: FolderOpen,      label: "Projects" },
  { to: "/tests",        icon: FlaskConical,    label: "Tests" },
  { to: "/reports",      icon: BarChart2,       label: "Reports" },
  { to: "/work",         icon: Briefcase,       label: "Work" },
  { to: "/context",      icon: Layers,          label: "Context" },
];

export default function Layout() {
  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg2)" }}>
      <Sidebar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <TopBar />
        <main style={{ flex: 1, padding: "28px 32px", overflow: "auto" }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside style={{
      width: 192, background: "var(--surface)", borderRight: "1px solid var(--border)",
      display: "flex", flexDirection: "column", flexShrink: 0,
      position: "sticky", top: 0, height: "100vh", overflowY: "auto",
    }}>
      {/* Logo */}
      <div style={{ padding: "18px 16px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, overflow: "hidden", background: "#111" }}>
            <img src="https://smartbear.com/favicon.ico" style={{ width: "100%", display: "none" }} onError={e => e.target.style.display = "none"} />
            <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#5b6ef5,#7c3aed)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 14 }}>S</div>
          </div>
          <span style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--text)" }}>Sentri</span>
        </div>
      </div>

      {/* Workspace */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: "var(--radius)", cursor: "pointer" }}
          className="hover-bg">
          <div>
            <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text)" }}>My Workspace</div>
            <div style={{ fontSize: "0.7rem", color: "var(--text3)" }}>Personal</div>
          </div>
          <Plus size={14} color="var(--text3)" />
        </div>
      </div>

      {/* Nav */}
      <nav style={{ padding: "10px 8px", flex: 1 }}>
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} style={({ isActive }) => ({
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

      {/* Settings at bottom */}
      <div style={{ padding: "10px 8px", borderTop: "1px solid var(--border)" }}>
        <NavLink to="/settings" style={({ isActive }) => ({
          display: "flex", alignItems: "center", gap: 9, padding: "7px 10px",
          borderRadius: "var(--radius)", fontWeight: isActive ? 600 : 400,
          fontSize: "0.875rem", color: isActive ? "var(--accent)" : "var(--text2)",
          background: isActive ? "var(--accent-bg)" : "transparent",
          textDecoration: "none",
        })}>
          <Settings size={16} />Settings
        </NavLink>
      </div>
    </aside>
  );
}

function TopBar() {
  return (
    <header style={{
      height: 52, background: "var(--surface)", borderBottom: "1px solid var(--border)",
      display: "flex", alignItems: "center", padding: "0 24px", gap: 12, flexShrink: 0,
    }}>
      {/* Search */}
      <div style={{ flex: 1, maxWidth: 420, position: "relative" }}>
        <Search size={14} color="var(--text3)" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
        <input
          className="input"
          placeholder="Give your team a task..."
          style={{ paddingLeft: 32, height: 34, fontSize: "0.83rem", background: "var(--bg2)", border: "1px solid var(--border)" }}
        />
      </div>
      <div style={{ flex: 1 }} />
      {/* Provider */}
      <ProviderBadge />
      {/* Avatar */}
      <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: "0.78rem", flexShrink: 0 }}>R</div>
    </header>
  );
}
