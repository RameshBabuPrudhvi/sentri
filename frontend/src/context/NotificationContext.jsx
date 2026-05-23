/**
 * @module context/NotificationContext
 * @description Global in-app notification center.
 *
 * Stores notifications in React state and persists them to localStorage so
 * they survive page navigations (but not across sessions — cleared on logout).
 *
 * ### Usage
 * ```jsx
 * import { useNotifications } from "../context/NotificationContext.jsx";
 *
 * const { addNotification, unreadCount } = useNotifications();
 * addNotification({ title: "Run complete", body: "3 passed · 1 failed", link: "/runs/RUN-1" });
 * ```
 *
 * ### Exports
 * - {@link NotificationProvider} — Wrap inside `<AuthProvider>` / `<BrowserRouter>`.
 * - {@link useNotifications}     — Hook to read/write notifications.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { coerceText as coerceTextPure, isBadStringified } from "../utils/notificationCoerce.js";

const NotificationContext = createContext();

const STORAGE_KEY = "app_notifications";
// ENT-005: snooze state lives in its own localStorage key so it survives
// `clearAll()` (which only wipes the notifications array) and so an
// accidental schema bump on the notifications payload can't lose the
// active snooze window. The value is an ISO timestamp string or null.
const SNOOZE_STORAGE_KEY = "app_notifications_snoozed_until";
const MAX_NOTIFICATIONS = 50;

/** Read a persisted snooze-until ISO string from localStorage, or null. */
function loadSnoozeFromStorage() {
  try {
    const raw = localStorage.getItem(SNOOZE_STORAGE_KEY);
    if (!raw) return null;
    // Validate it's a parseable timestamp and still in the future. Past
    // values are stale (snooze already expired) — treat as null so the
    // bell doesn't render a "Snoozed until <yesterday>" footer.
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t) || t <= Date.now()) return null;
    return raw;
  } catch { return null; }
}

/** Persist or clear the snooze-until ISO string. */
function saveSnoozeToStorage(isoOrNull) {
  try {
    if (isoOrNull) localStorage.setItem(SNOOZE_STORAGE_KEY, isoOrNull);
    else localStorage.removeItem(SNOOZE_STORAGE_KEY);
  } catch { /* localStorage unavailable / quota — non-fatal */ }
}

/**
 * Coerce arbitrary input to a readable string for notification title/body.
 *
 * Thin wrapper around the pure helper in `utils/notificationCoerce.js` that
 * wires a dev-mode `console.warn` for non-string inputs. The pure helper is
 * unit-tested under `frontend/tests/notification-coerce.test.js`; this layer
 * is the React-bundle integration point (it's the one that knows about
 * `import.meta.env.DEV`).
 *
 * @param {unknown} value
 * @param {string} field   Field name used in the dev warning ("title" | "body").
 * @returns {string}
 */
function coerceText(value, field = "value") {
  return coerceTextPure(value, field, (fieldName, badValue) => {
    // Warn in dev so regressions are easy to find. Vite exposes
    // `import.meta.env.DEV`; the try guard covers test runners (jest,
    // node esm) where `import.meta.env` may be undefined.
    try {
      if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(`[NotificationContext] non-string ${fieldName} passed to addNotification; coercing.`, badValue);
      }
    } catch { /* ignore */ }
  });
}

/** Read persisted notifications from localStorage, sanitizing legacy bad entries. */
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_NOTIFICATIONS).map(n => {
      const title = isBadStringified(n?.title) ? "" : (typeof n?.title === "string" ? n.title : coerceText(n?.title, "title"));
      const body  = isBadStringified(n?.body)  ? "" : (typeof n?.body  === "string" ? n.body  : coerceText(n?.body,  "body"));
      return { ...n, title, body };
    });
  } catch { return []; }
}

/** Persist notifications to localStorage. */
function saveToStorage(notifications) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS)));
  } catch { /* quota exceeded — non-fatal */ }
}

/**
 * @param {{ children: React.ReactNode }} props
 */
export function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState(loadFromStorage);
  // ENT-005: `snoozedUntil` is an ISO timestamp (or null) indicating
  // "suppress new notifications until this moment". When non-null + in the
  // future, `addNotification` still PERSISTS the row so the audit trail is
  // intact, but the bell badge (`unreadCount`) collapses to 0 and the
  // dropdown header surfaces a "Snoozed until <time>" affordance with a
  // one-click resume. Industry-standard pattern: Slack, GitHub, Linear all
  // expose snooze as a top-level bell affordance.
  const [snoozedUntil, setSnoozedUntilState] = useState(loadSnoozeFromStorage);

  // Auto-expire the snooze when its window passes. Without this, an
  // open tab whose snooze window elapses while the user is away (laptop
  // suspended overnight, tab in background) would stay snoozed until the
  // next page reload — counterintuitive vs Slack's behaviour where the
  // bell wakes itself up the moment "Until tomorrow" elapses. A single
  // setTimeout scheduled at the exact expiry instant covers this without
  // a polling loop.
  useEffect(() => {
    if (!snoozedUntil) return;
    const remaining = new Date(snoozedUntil).getTime() - Date.now();
    if (remaining <= 0) {
      setSnoozedUntilState(null);
      saveSnoozeToStorage(null);
      return;
    }
    const t = setTimeout(() => {
      setSnoozedUntilState(null);
      saveSnoozeToStorage(null);
    }, remaining);
    return () => clearTimeout(t);
  }, [snoozedUntil]);

  // Sync to localStorage whenever notifications change.
  //
  // On the FIRST render we still write back — but only if `loadFromStorage`
  // actually sanitized something (legacy `[object Object]` entries from
  // pre-fix callsites). Without this, the sanitized array lives only in
  // React state and the bad localStorage payload persists across reloads
  // until a notification mutation triggers a save. The acceptance criterion
  // at `docs/roadmap/sentri-ux-audit-22May2026.md` requires durable cleanup
  // on next page load. Detecting "sanitization occurred" up-front avoids
  // an unnecessary write on the happy path (clean storage → no-op).
  const isFirstRender = useRef(true);
  const needsRehydrate = useRef(false);
  if (isFirstRender.current && typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw && raw !== JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS))) {
        needsRehydrate.current = true;
      }
    } catch { /* localStorage unavailable */ }
  }
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (needsRehydrate.current) saveToStorage(notifications);
      return;
    }
    saveToStorage(notifications);
  }, [notifications]);

  // ENT-005: when snoozed, the bell badge MUST read 0 — that's the entire
  // point of the snooze. Notifications keep being persisted (audit trail
  // intact, user can still expand the dropdown and read them) but the
  // user explicitly asked not to be nagged with a badge during this window.
  // Slack / Linear / GitHub all behave this way.
  const isSnoozed = !!snoozedUntil && new Date(snoozedUntil).getTime() > Date.now();
  const rawUnreadCount = notifications.filter(n => !n.read).length;
  const unreadCount = isSnoozed ? 0 : rawUnreadCount;

  /**
   * Add a new notification.
   * @param {{ title: string, body: string, link?: string, type?: "success"|"error"|"info"|"warning" }} notif
   */
  const addNotification = useCallback((notif) => {
    const entry = {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: coerceText(notif.title, "title"),
      body: coerceText(notif.body, "body"),
      link: notif.link || null,
      type: notif.type || "info",
      read: false,
      createdAt: new Date().toISOString(),
    };
    setNotifications(prev => [entry, ...prev].slice(0, MAX_NOTIFICATIONS));
  }, []);

  const markRead = useCallback((id) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  /**
   * ENT-005: snooze the bell until a given moment.
   *
   * @param {Date|string|number|null} until - When to wake. Accepts a Date,
   *   an ISO timestamp string, an epoch-millis number, or `null` to clear
   *   the snooze immediately. Past values are coerced to `null` (no-op).
   */
  const setSnoozedUntil = useCallback((until) => {
    if (until == null) {
      setSnoozedUntilState(null);
      saveSnoozeToStorage(null);
      return;
    }
    const t = until instanceof Date ? until.getTime()
      : typeof until === "number" ? until
      : new Date(until).getTime();
    if (!Number.isFinite(t) || t <= Date.now()) {
      setSnoozedUntilState(null);
      saveSnoozeToStorage(null);
      return;
    }
    const iso = new Date(t).toISOString();
    setSnoozedUntilState(iso);
    saveSnoozeToStorage(iso);
  }, []);

  /** Convenience clearer — same as `setSnoozedUntil(null)`. */
  const clearSnooze = useCallback(() => {
    setSnoozedUntilState(null);
    saveSnoozeToStorage(null);
  }, []);

  return (
    <NotificationContext.Provider value={{
      notifications,
      unreadCount,
      addNotification,
      markRead,
      markAllRead,
      clearAll,
      // ENT-005 — snooze surface. `isSnoozed` is the derived boolean the
      // bell checks for badge suppression + dropdown footer rendering;
      // `snoozedUntil` is the exact instant for the "Snoozed until X" copy.
      isSnoozed,
      snoozedUntil,
      setSnoozedUntil,
      clearSnooze,
    }}>
      {children}
    </NotificationContext.Provider>
  );
}

/**
 * Hook to access the notification center.
 * @returns {{ notifications: object[], unreadCount: number, addNotification: Function, markRead: Function, markAllRead: Function, clearAll: Function, isSnoozed: boolean, snoozedUntil: string|null, setSnoozedUntil: Function, clearSnooze: Function }}
 */
export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within <NotificationProvider>");
  return ctx;
}
