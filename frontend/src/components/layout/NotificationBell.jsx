/**
 * @module components/layout/NotificationBell
 * @description Bell icon with unread badge + dropdown notification list.
 *
 * Lives in the TopBar (Layout.jsx). Reads from NotificationContext.
 * Each notification is clickable and navigates to the relevant run.
 */

import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff, CheckCircle2, XCircle, AlertTriangle, Sparkles, Trash2, CheckCheck, Settings, ChevronDown } from "lucide-react";
import { useNotifications } from "../../context/NotificationContext.jsx";

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

/**
 * ENT-005: human-readable wake-time label for the snooze footer.
 * "Until 3:45 PM" / "Until tomorrow 9:00 AM" / "Until Mon 9:00 AM"
 */
function snoozeWakeLabel(iso) {
  const wake = new Date(iso);
  const now = new Date();
  const sameDay = wake.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = wake.toDateString() === tomorrow.toDateString();
  const time = wake.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Snoozed until ${time}`;
  if (isTomorrow) return `Snoozed until tomorrow ${time}`;
  return `Snoozed until ${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/**
 * ENT-005: pre-built snooze presets. Industry-standard rhythm
 * (Slack: 30m / 1h / 2h / Until tomorrow; Linear: 1h / 4h / Tomorrow;
 * GitHub: 1 day / 3 days / 1 week). We pick a compact set that covers
 * "the meeting" (1h), "the rest of the workday" (8h), and "until tomorrow
 * morning" (next 9am) so users don't need a date picker for 90% of cases.
 */
function snoozePresets() {
  const now = new Date();
  const tomorrow9am = new Date(now);
  tomorrow9am.setDate(tomorrow9am.getDate() + 1);
  tomorrow9am.setHours(9, 0, 0, 0);
  return [
    { label: "For 1 hour", until: new Date(now.getTime() + 60 * 60 * 1000) },
    { label: "For 8 hours", until: new Date(now.getTime() + 8 * 60 * 60 * 1000) },
    { label: "Until tomorrow 9:00 AM", until: tomorrow9am },
  ];
}

/** Icon for notification type. */
function TypeIcon({ type }) {
  if (type === "success") return <CheckCircle2 size={14} color="var(--green)" />;
  if (type === "error")   return <XCircle size={14} color="var(--red)" />;
  if (type === "warning") return <AlertTriangle size={14} color="var(--amber)" />;
  return <Sparkles size={14} color="var(--accent)" />;
}

export default function NotificationBell() {
  const {
    notifications, unreadCount, markRead, markAllRead, clearAll,
    isSnoozed, snoozedUntil, setSnoozedUntil, clearSnooze,
  } = useNotifications();
  const [open, setOpen] = useState(false);
  // ENT-005: snooze submenu state is local — opens inline when the user
  // clicks "Snooze ▾" in the header. Auto-closes when the dropdown itself
  // closes (the `open` effect below resets it).
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  // Close dropdown when clicking outside
  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setSnoozeMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // Auto-collapse the snooze submenu whenever the dropdown closes, so
  // re-opening the bell always starts from the clean "Snooze ▾" affordance
  // state rather than a stale open submenu the user already saw.
  useEffect(() => { if (!open) setSnoozeMenuOpen(false); }, [open]);

  function handleClick(notif) {
    markRead(notif.id);
    if (notif.link) {
      navigate(notif.link);
      setOpen(false);
    }
  }

  /** ENT-005: navigate to per-project notification settings.
   *  There's no global Settings → Notifications page (notification settings
   *  are per-project — `backend/src/routes/projects.js#/:id/notifications`),
   *  so the most useful destination is the projects list where the user
   *  picks the project whose channels they want to configure. */
  function openNotificationSettings() {
    navigate("/projects");
    setOpen(false);
  }

  return (
    <div ref={ref} className="notif-bell">
      {/* Bell button */}
      <button
        onClick={() => setOpen(v => !v)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        className={`notif-bell-btn${open ? " notif-bell-btn--open" : ""}`}
      >
        {/* ENT-005: the bell icon flips to BellOff while snoozed so the
            user sees state at a glance without opening the dropdown.
            Matches Slack's bell-with-Z affordance — the icon itself is
            the badge for "you've explicitly muted me". */}
        {isSnoozed
          ? <BellOff size={18} color="var(--text3)" />
          : <Bell size={18} color="var(--text2)" />}
        {unreadCount > 0 && (
          <span className="notif-bell-badge">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="notif-dropdown">
          {/* Header */}
          <div className="notif-header">
            <span className="notif-header__title">
              Notifications
              {unreadCount > 0 && (
                <span className="notif-header__count-pill">
                  {unreadCount} new
                </span>
              )}
            </span>
            <div className="notif-header__actions">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  title="Mark all read"
                  aria-label="Mark all notifications as read"
                  className="notif-icon-btn notif-icon-btn--accent"
                >
                  <CheckCheck size={15} />
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={clearAll}
                  title="Clear all"
                  aria-label="Clear all notifications"
                  className="notif-icon-btn notif-icon-btn--danger"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>

          {/* List */}
          <div className="notif-list">
            {notifications.length === 0 ? (
              <div className="notif-empty">
                <Bell size={28} color="var(--border2)" className="notif-empty__icon" />
                <div>No notifications yet</div>
              </div>
            ) : (
              notifications.map(notif => {
                const rowCls = [
                  "notif-row",
                  notif.read ? "" : "notif-row--unread",
                  notif.link ? "notif-row--clickable" : "",
                ].filter(Boolean).join(" ");
                return (
                  <button
                    key={notif.id}
                    onClick={() => handleClick(notif)}
                    className={rowCls}
                  >
                    <div className="notif-row__icon">
                      <TypeIcon type={notif.type} />
                    </div>
                    <div className="notif-row__body">
                      <div className="notif-row__title">
                        {/* Defensive String() — older callsites occasionally
                            stuffed structured objects (e.g. `{ type, message }`
                            error envelopes) into the notification. React throws
                            "Objects are not valid as a React child" the moment
                            one of those persisted entries lands here from
                            localStorage, breaking the entire dropdown. Coercing
                            to a string at the leaf keeps the surface working
                            even when bad legacy data is in storage. */}
                        {typeof notif.title === "string" ? notif.title : String(notif.title ?? "")}
                      </div>
                      <div className="notif-row__text">
                        {typeof notif.body === "string" ? notif.body : String(notif.body ?? "")}
                      </div>
                    </div>
                    <div className="notif-row__time">
                      {timeAgo(notif.createdAt)}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* ENT-005: snoozed-state banner. Surfaces when the user has an
              active snooze so they know "no badges right now" is by
              their own choice, with a one-click resume. */}
          {isSnoozed && (
            <div className="notif-snooze-banner">
              <BellOff size={13} />
              <span className="notif-snooze-banner__label">
                {snoozeWakeLabel(snoozedUntil)}
              </span>
              <button
                onClick={() => clearSnooze()}
                className="notif-snooze-banner__resume"
              >
                Resume
              </button>
            </div>
          )}

          {/* ENT-005: footer with Snooze submenu + Notification settings
              link. Industry-standard discoverability — top-level affordances
              the user expects (Slack, Linear, GitHub all put settings here)
              instead of forcing a hunt through the Settings page. The
              snooze button toggles a small in-place menu; the settings
              button deep-links to the project list since notification
              channels are per-project (`backend/src/routes/projects.js`). */}
          <div className="notif-footer">
            <button
              onClick={() => setSnoozeMenuOpen(v => !v)}
              aria-haspopup="menu"
              aria-expanded={snoozeMenuOpen}
              className="notif-footer-btn"
            >
              <BellOff size={12} />
              Snooze
              <ChevronDown size={11} />
            </button>

            <div className="notif-footer__spacer" />

            <button
              onClick={openNotificationSettings}
              className="notif-footer-btn"
            >
              <Settings size={12} />
              Notification settings
            </button>

            {/* Snooze submenu — absolutely positioned over the list so it
                doesn't push the footer up and shift layout. */}
            {snoozeMenuOpen && (
              <div role="menu" className="notif-snooze-menu">
                {snoozePresets().map(p => (
                  <button
                    key={p.label}
                    role="menuitem"
                    onClick={() => {
                      setSnoozedUntil(p.until);
                      setSnoozeMenuOpen(false);
                    }}
                    className="notif-snooze-menu__item"
                  >
                    {p.label}
                  </button>
                ))}
                {isSnoozed && (
                  <>
                    <div className="notif-snooze-menu__separator" />
                    <button
                      role="menuitem"
                      onClick={() => { clearSnooze(); setSnoozeMenuOpen(false); }}
                      className="notif-snooze-menu__item notif-snooze-menu__item--danger"
                    >
                      Resume notifications
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}