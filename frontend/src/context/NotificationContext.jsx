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
const MAX_NOTIFICATIONS = 50;

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

  const unreadCount = notifications.filter(n => !n.read).length;

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

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, addNotification, markRead, markAllRead, clearAll }}>
      {children}
    </NotificationContext.Provider>
  );
}

/**
 * Hook to access the notification center.
 * @returns {{ notifications: object[], unreadCount: number, addNotification: Function, markRead: Function, markAllRead: Function, clearAll: Function }}
 */
export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within <NotificationProvider>");
  return ctx;
}
