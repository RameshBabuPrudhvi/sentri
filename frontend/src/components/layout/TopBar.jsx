import React from "react";
import { useNavigate } from "react-router-dom";
import { Search, LogOut, ChevronDown, BookOpen, ExternalLink, Sparkles } from "lucide-react";
import ProviderBadge from "./ProviderBadge.jsx";
import NotificationBell from "./NotificationBell.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import ThemeToggle from "./ThemeToggle.jsx";

export default function TopBar({ onOpenPalette, onOpenChat }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef(null);

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  // Global shortcut: Cmd/Ctrl+K to open command palette
  React.useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenPalette();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onOpenPalette]);

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
    <header className="topbar">
      {/* Command palette trigger */}
      <button
        onClick={() => onOpenPalette()}
        className="chat-trigger"
        title="Command palette (⌘K)"
      >
        <Search size={13} color="var(--text3)" />
        <span className="chat-trigger__placeholder">Search commands or ask AI…</span>
        <span className="chat-trigger__kbd">
          <Sparkles size={9} />⌘K
        </span>
      </button>

      <div className="topbar__spacer" />
      <ProviderBadge />
      <ThemeToggle />
      <NotificationBell />

      {/* User menu */}
      <div ref={menuRef} className="topbar-user">
        <button
          onClick={() => setMenuOpen(v => !v)}
          className={`topbar-user__btn${menuOpen ? " topbar-user__btn--open" : ""}`}
          aria-label="User menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <div className="topbar-user__avatar">
            {initials}
          </div>
          <ChevronDown
            size={13}
            color="var(--text3)"
            className={`topbar-user__chevron${menuOpen ? " topbar-user__chevron--open" : ""}`}
          />
        </button>

        {menuOpen && (
          <div className="topbar-user-dropdown" role="menu">
            {/* User info */}
            <div className="topbar-user-dropdown__info">
              <div className="topbar-user-dropdown__name">{user?.name || "User"}</div>
              <div className="topbar-user-dropdown__email">{user?.email}</div>
            </div>
            {/* Command palette shortcut */}
            <button
              onClick={() => { setMenuOpen(false); onOpenPalette(); }}
              className="topbar-user-dropdown__item"
              role="menuitem"
            >
              <Search size={14} />
              Search / AI
              <span className="topbar-user-dropdown__item-meta">⌘K</span>
            </button>
            {/* Docs */}
            <a
              href={`${import.meta.env.BASE_URL}docs/`}
              target="_blank"
              rel="noopener noreferrer"
              className="topbar-user-dropdown__item"
              role="menuitem"
            >
              <BookOpen size={14} />
              Documentation
              <ExternalLink size={10} className="topbar-user-dropdown__item-icon-end" />
            </a>
            {/* Sign out */}
            <button
              onClick={handleLogout}
              className="topbar-user-dropdown__item topbar-user-dropdown__item--danger"
              role="menuitem"
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
