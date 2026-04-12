import React from "react";
import { useNotifications } from "../../context/NotificationContext.jsx";
import { Bell } from "lucide-react";

export default function NotificationBell() {
  const { notifications } = useNotifications();
  const unread = notifications.filter(n => !n.read).length;

  return (
    <button
      style={{
        position: "relative", display: "flex", alignItems: "center",
        justifyContent: "center", width: 32, height: 32, borderRadius: 8,
        background: "none", border: "1px solid transparent",
        cursor: "pointer", color: "var(--text2)", flexShrink: 0,
        transition: "background 0.15s, border-color 0.15s",
      }}
      onMouseEnter={e => { e.currentTarget.style.background = "var(--bg2)"; e.currentTarget.style.borderColor = "var(--border)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.borderColor = "transparent"; }}
      title={unread > 0 ? `${unread} unread notification${unread !== 1 ? "s" : ""}` : "No notifications"}
      aria-label="Notifications"
    >
      <Bell size={16} />
      {unread > 0 && (
        <span style={{
          position: "absolute", top: 4, right: 4,
          width: 8, height: 8, borderRadius: "50%",
          background: "var(--red)", border: "2px solid var(--surface)",
        }} />
      )}
    </button>
  );
}
