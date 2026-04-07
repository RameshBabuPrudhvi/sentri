import React from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, FlaskConical, FolderOpen, BarChart2, Briefcase, Layers, Settings, Search, X, LogOut, ChevronDown, BookOpen, ExternalLink } from "lucide-react";
import ProviderBadge from "./ProviderBadge.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import AppLogo from "./AppLogo.jsx";

const NAV = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/projects",  icon: FolderOpen,      label: "Projects"  },
  { to: "/tests",     icon: FlaskConical,    label: "Tests"     },
  { to: "/reports",   icon: BarChart2,       label: "Reports"   },
  { to: "/runs",      icon: Briefcase,       label: "Runs"      },
  { to: "/context",   icon: Layers,          label: "System"    },
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
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} className="nav-link" style={({ isActive }) => ({
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
        <NavLink to="/settings" className="nav-link" style={({ isActive }) => ({
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

function TopBar() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [q, setQ] = React.useState("");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef(null);

  function handleSearch(e) {
    if (e.key === "Enter" && q.trim()) {
      navigate(`/tests?q=${encodeURIComponent(q.trim())}`);
      setQ("");
    }
  }

  function clearSearch() {
    setQ("");
  }

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  // Close menu when clicking outside
  React.useEffect(() => {
    function onClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const initials = user?.name
    ? user.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()
    : user?.email?.[0]?.toUpperCase() ?? "?";

  return (
    <header style={{
      height: 52, background: "var(--surface)", borderBottom: "1px solid var(--border)",
      display: "flex", alignItems: "center", padding: "0 24px", gap: 12, flexShrink: 0,
    }}>
      {/* Search */}
      <div style={{ flex: 1, maxWidth: 420, position: "relative" }}>
        <Search size={14} color="var(--text3)" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
        {/* Hidden dummy field prevents Chrome from autofilling the visible search input with saved credentials */}
        <input type="text" name="prevent-autofill" autoComplete="username" style={{ position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" }} tabIndex={-1} aria-hidden="true" />
        <input
          className="input"
          type="search"
          name="global-search"
          autoComplete="off"
          data-form-type="other"
          data-lpignore="true"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={handleSearch}
          placeholder="Search tests… (press Enter)"
          style={{ paddingLeft: 32, paddingRight: q ? 32 : 12, height: 34, fontSize: "0.83rem", background: "var(--bg2)", border: "1px solid var(--border)" }}
        />
        {q && (
          <button onClick={clearSearch} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 0, display: "flex" }}>
            <X size={13} />
          </button>
        )}
      </div>
      <div style={{ flex: 1 }} />
      <ProviderBadge />

      {/* User menu */}
      <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
        <button
          onClick={() => setMenuOpen(v => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "none", border: "1px solid transparent", borderRadius: 8,
            padding: "3px 6px 3px 3px", cursor: "pointer",
            transition: "border-color 0.15s, background 0.15s",
            ...(menuOpen ? { background: "var(--bg2)", borderColor: "var(--border)" } : {}),
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--bg2)"; e.currentTarget.style.borderColor = "var(--border)"; }}
          onMouseLeave={e => { if (!menuOpen) { e.currentTarget.style.background = "none"; e.currentTarget.style.borderColor = "transparent"; } }}
          aria-label="User menu"
        >
          <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: "0.72rem" }}>
            {initials}
          </div>
          <ChevronDown size={13} color="var(--text3)" style={{ transition: "transform 0.2s", transform: menuOpen ? "rotate(180deg)" : "none" }} />
        </button>

        {menuOpen && (
          <div style={{
            position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 100,
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
            minWidth: 200, overflow: "hidden",
          }}>
            {/* User info */}
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{user?.name || "User"}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--text3)" }}>{user?.email}</div>
            </div>
            {/* Docs */}
            <a
              href={`${import.meta.env.BASE_URL}docs/`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "center", gap: 9,
                width: "100%", padding: "10px 14px",
                fontSize: "0.83rem", color: "var(--text2)", textDecoration: "none",
                transition: "background 0.12s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--bg2)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "none"; }}
            >
              <BookOpen size={14} />
              Documentation
              <ExternalLink size={10} style={{ marginLeft: "auto", opacity: 0.4 }} />
            </a>
            {/* Sign out */}
            <button
              onClick={handleLogout}
              style={{
                display: "flex", alignItems: "center", gap: 9,
                width: "100%", padding: "10px 14px",
                background: "none", border: "none", cursor: "pointer",
                fontSize: "0.83rem", color: "var(--text2)", textAlign: "left",
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--bg2)"; e.currentTarget.style.color = "#ef4444"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text2)"; }}
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
