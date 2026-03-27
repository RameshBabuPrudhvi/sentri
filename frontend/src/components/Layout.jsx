import React from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import { LayoutDashboard, FolderOpen, Plus, Github, Zap } from "lucide-react";

const navItems = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/projects", icon: FolderOpen, label: "Projects" },
];

export default function Layout() {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar />
      <main style={{ flex: 1, overflow: "auto", padding: "32px 40px" }}>
        <Outlet />
      </main>
    </div>
  );
}

function Sidebar() {
  return (
    <aside style={{
      width: 220, background: "var(--bg2)", borderRight: "1px solid var(--border)",
      display: "flex", flexDirection: "column", padding: "24px 0", flexShrink: 0,
      position: "sticky", top: 0, height: "100vh",
    }}>
      {/* Logo */}
      <div style={{ padding: "0 20px 28px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 34, height: 34, background: "var(--accent)", borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18, boxShadow: "0 0 16px rgba(0,229,255,0.4)",
          }}>🐻</div>
          <div>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1rem", color: "var(--text)" }}>BearQA</div>
            <div style={{ fontSize: "0.7rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>autonomous qa</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ padding: "20px 12px", flex: 1 }}>
        <div style={{ fontSize: "0.65rem", fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--text3)", letterSpacing: "0.1em", textTransform: "uppercase", padding: "0 8px 10px" }}>Navigation</div>
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} style={({ isActive }) => ({
            display: "flex", alignItems: "center", gap: 10,
            padding: "9px 12px", borderRadius: "var(--radius)", marginBottom: 2,
            fontFamily: "var(--font-display)", fontWeight: isActive ? 600 : 500,
            fontSize: "0.875rem", color: isActive ? "var(--accent)" : "var(--text2)",
            background: isActive ? "rgba(0,229,255,0.07)" : "transparent",
            textDecoration: "none", transition: "all 0.15s",
            borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
          })}>
            <Icon size={16} />
            {label}
          </NavLink>
        ))}

        <div style={{ marginTop: 20, padding: "0 8px 10px", fontSize: "0.65rem", fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--text3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Actions</div>
        <NavLink to="/projects/new" style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "9px 12px", borderRadius: "var(--radius)",
          fontFamily: "var(--font-display)", fontWeight: 500,
          fontSize: "0.875rem", color: "var(--text2)",
          textDecoration: "none", transition: "all 0.15s",
          border: "1px dashed var(--border2)",
        }}>
          <Plus size={16} />
          New Project
        </NavLink>
      </nav>

      {/* Footer */}
      <div style={{ padding: "20px", borderTop: "1px solid var(--border)" }}>
        <div style={{
          background: "rgba(0,229,255,0.05)", border: "1px solid rgba(0,229,255,0.1)",
          borderRadius: "var(--radius)", padding: "12px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <Zap size={12} color="var(--accent)" />
            <span style={{ fontSize: "0.75rem", fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--accent)" }}>AI Powered</span>
          </div>
          <div style={{ fontSize: "0.7rem", color: "var(--text3)", lineHeight: 1.5 }}>
            Autonomous test generation via Claude AI
          </div>
        </div>
      </div>
    </aside>
  );
}
