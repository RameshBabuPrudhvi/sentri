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

const NotificationContext = createContext();

const STORAGE_KEY = "app_notifications";
const MAX_NOTIFICATIONS = 50;

/** Read persisted notifications from localStorage. */
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_NOTIFICATIONS) : [];
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

  // Sync to localStorage whenever notifications change
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
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
      title: notif.title,
      body: notif.body,
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
