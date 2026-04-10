/**
 * @module components/NotificationBell
 * @description Bell icon with unread badge + dropdown notification list.
 *
 * Lives in the TopBar (Layout.jsx). Reads from NotificationContext.
 * Each notification is clickable and navigates to the relevant run.
 */

import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCircle2, XCircle, AlertTriangle, Sparkles, Trash2, CheckCheck } from "lucide-react";
import { useNotifications } from "../context/NotificationContext.jsx";

/** Relative time label (e.g. "2m ago", "1h ago", "3d ago"). */
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/** Icon for notification type. */
function TypeIcon({ type }) {
  if (type === "success") return <CheckCircle2 size={14} color="var(--green)" />;
  if (type === "error")   return <XCircle size={14} color="var(--red)" />;
  if (type === "warning") return <AlertTriangle size={14} color="var(--amber)" />;
  return <Sparkles size={14} color="var(--accent)" />;
}

export default function NotificationBell() {
  const { notifications, unreadCount, markRead, markAllRead, clearAll } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  // Close dropdown when clicking outside
  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function handleClick(notif) {
    markRead(notif.id);
    if (notif.link) {
      navigate(notif.link);
      setOpen(false);
    }
  }

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(v => !v)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        className="notif-bell-btn"
        style={{
          position: "relative",
          background: open ? "var(--bg2)" : "none",
          border: "1px solid transparent",
          borderColor: open ? "var(--border)" : "transparent",
          borderRadius: 8, padding: 6, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 0.15s, border-color 0.15s",
        }}
      >
        <Bell size={18} color="var(--text2)" />
        {unreadCount > 0 && (
          <span style={{
            position: "absolute", top: 2, right: 2,
            minWidth: 16, height: 16, borderRadius: 99,
            background: "var(--red)", color: "#fff",
            fontSize: "0.62rem", fontWeight: 700,
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "0 4px", lineHeight: 1,
            border: "2px solid var(--surface)",
          }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="notif-dropdown" style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 100,
          width: 360, maxHeight: 440,
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "12px 14px", borderBottom: "1px solid var(--border)",
          }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text)" }}>
              Notifications
              {unreadCount > 0 && (
                <span style={{
                  marginLeft: 8, fontSize: "0.68rem", fontWeight: 600,
                  background: "var(--accent-bg)", color: "var(--accent)",
                  padding: "1px 7px", borderRadius: 99,
                }}>
                  {unreadCount} new
                </span>
              )}
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  title="Mark all read"
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--text3)", padding: 4, display: "flex",
                    borderRadius: 6, transition: "color 0.12s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.color = "var(--text3)"; }}
                >
                  <CheckCheck size={15} />
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={clearAll}
                  title="Clear all"
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--text3)", padding: 4, display: "flex",
                    borderRadius: 6, transition: "color 0.12s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = "var(--red)"; }}
                  onMouseLeave={e => { e.currentTarget.style.color = "var(--text3)"; }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>

          {/* List */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {notifications.length === 0 ? (
              <div style={{
                padding: "40px 20px", textAlign: "center",
                color: "var(--text3)", fontSize: "0.82rem",
              }}>
                <Bell size={28} color="var(--border2)" style={{ marginBottom: 10 }} />
                <div>No notifications yet</div>
              </div>
            ) : (
              notifications.map(notif => (
                <button
                  key={notif.id}
                  onClick={() => handleClick(notif)}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10,
                    width: "100%", padding: "10px 14px",
                    background: notif.read ? "none" : "var(--accent-bg)",
                    border: "none", borderBottom: "1px solid var(--border)",
                    cursor: notif.link ? "pointer" : "default",
                    textAlign: "left", transition: "background 0.12s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--bg2)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = notif.read ? "none" : "var(--accent-bg)"; }}
                >
                  <div style={{ marginTop: 2, flexShrink: 0 }}>
                    <TypeIcon type={notif.type} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: "0.8rem", fontWeight: notif.read ? 500 : 700,
                      color: "var(--text)", marginBottom: 2,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {notif.title}
                    </div>
                    <div style={{
                      fontSize: "0.75rem", color: "var(--text2)", lineHeight: 1.4,
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}>
                      {notif.body}
                    </div>
                  </div>
                  <div style={{
                    fontSize: "0.66rem", color: "var(--text3)",
                    whiteSpace: "nowrap", flexShrink: 0, marginTop: 2,
                  }}>
                    {timeAgo(notif.createdAt)}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
