/**
 * @module context/ToastContext
 * @description Global toast feedback for save/update/delete actions (UX-001).
 *
 * Why this exists:
 *   Multiple pages had drifted to inconsistent feedback patterns:
 *     - `frontend/src/pages/ProjectDetail.jsx` uses a local `showToast` +
 *       in-component `<RunToast>` (works, but only visible on that page).
 *     - `frontend/src/pages/Automation.jsx:68-73` wired the `onToast` prop
 *       from `<ProjectQualityCard>` / `<ConfigurablePanel>` etc. to
 *       `addNotification()` — the notification BELL — so users saving
 *       Auto-Approval threshold, Quality Gates, Web Vitals, or Coverage
 *       settings saw NO visible confirmation.
 *     - `frontend/src/features/settings/sections/*` silently completed
 *       every save/update/delete (only `setError` on failure).
 *
 *   This provider gives the whole app a single `useToast()` hook that
 *   renders the same `<RunToast>` visual already used by ProjectDetail.
 *   The notification bell (`useNotifications`) stays untouched — it's for
 *   durable async events (run-complete, scheduled-trigger fired, PR-check
 *   posted), not for "I just clicked Save."
 *
 * Usage:
 *   const { showToast } = useToast();
 *   showToast("Saved", "success");
 *   showToast("Failed: invalid threshold", "error");
 *
 * Signature is `(msg, type)` to match the existing call sites in
 * `ProjectDetail.jsx:130-133`, `EnvironmentsTab.jsx:75`, and
 * `ConfigurablePanel.jsx:105`. Callers using the `{ type, message }` object
 * form (currently only `ProjectQualityCard.jsx`) should be migrated to
 * `(msg, type)` in the same PR — see the audit task list.
 */
import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import RunToast from "../components/project/RunToast.jsx";

const ToastContext = createContext(null);

/**
 * @typedef {"success"|"error"|"info"} ToastType
 */

/** Auto-dismiss timings — error toasts linger longer so users can read them. */
const TIMING = { success: 3500, info: 3500, error: 5000 };

export function ToastProvider({ children }) {
  const [toast, setToast] = useState({
    msg: "",
    type: "info",
    visible: false,
    showLink: false,
    runId: null,
  });
  const timerRef = useRef(null);

  /**
   * Show a toast. Pass either `(msg, type)` or `(msg, type, runId)` — the
   * `runId` form is used by ProjectDetail.jsx's "Regression run started"
   * toast and renders a "View run" button in the bottom-right of the toast.
   *
   * @param {string} msg
   * @param {ToastType} [type="info"]
   * @param {string|null} [runId=null]
   */
  const showToast = useCallback((msg, type = "info", runId = null) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast({ msg, type, visible: true, showLink: !!runId, runId });
    const dur = TIMING[type] ?? TIMING.info;
    timerRef.current = setTimeout(() => {
      setToast((t) => ({ ...t, visible: false }));
      timerRef.current = null;
    }, dur);
  }, []);

  /** Imperative hide — rarely needed, but lets callers dismiss early. */
  const hideToast = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast((t) => ({ ...t, visible: false }));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, hideToast }}>
      {children}
      {/* RunToast is the existing visual primitive (bottom-right floating
          pill with a coloured status dot). Reused verbatim so this provider
          ships without any visual regression on ProjectDetail. The
          `onViewRun` prop is what triggers the "View run" CTA — we only
          pass it when the caller supplied a runId. */}
      <RunToast
        msg={toast.msg}
        type={toast.type}
        visible={toast.visible}
        onViewRun={toast.showLink ? () => {} : undefined}
        runId={toast.runId}
      />
    </ToastContext.Provider>
  );
}

/**
 * @returns {{ showToast: (msg: string, type?: ToastType, runId?: string|null) => void,
 *             hideToast: () => void }}
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error(
      "useToast() must be called inside <ToastProvider>. " +
      "Mount it once near the top of App.jsx, above <Routes>."
    );
  }
  return ctx;
}
