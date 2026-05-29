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
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
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
    action: null,
  });
  const timerRef = useRef(null);

  /**
   * Show a toast.
   *
   * Three call shapes — kept backward-compatible with every existing site:
   *   - `showToast("Saved", "success")`                — plain
   *   - `showToast("Run started", "info", runId)`      — adds "View run" CTA
   *   - `showToast("47 tests approved", "success", { action: { label: "Undo", onClick: () => ... } })`
   *
   * The third arg discriminates on type: a string is treated as a runId for
   * the "View run" link (legacy), an object as a generic options bag. Action
   * toasts linger for the error-toast duration (5s) regardless of `type` so
   * the user has time to react — a 3.5s success-toast window is too short
   * for an "Undo" decision on a bulk action.
   *
   * @param {string} msg
   * @param {ToastType} [type="info"]
   * @param {string|{action?:{label:string,onClick:Function},runId?:string}|null} [opts=null]
   */
  const showToast = useCallback((msg, type = "info", opts = null) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Normalise the legacy `runId` string form vs. the object form. Keeping
    // the positional contract avoids touching the ~30 existing call sites.
    const runId = typeof opts === "string" ? opts : opts?.runId ?? null;
    const action = (opts && typeof opts === "object" && opts.action) ? opts.action : null;
    setToast({
      msg,
      type,
      visible: true,
      showLink: !!runId,
      runId,
      action,
    });
    // Actionable toasts (Undo / View run) get a longer window so the user
    // can actually react. Plain success/info still auto-dismiss at 3.5s.
    const dur = action ? TIMING.error : (TIMING[type] ?? TIMING.info);
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
    <ToastContext.Provider value={useMemo(() => ({ showToast, hideToast }), [showToast, hideToast])}>
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
        onDismiss={hideToast}
        action={toast.action ? {
          label: toast.action.label,
          // Wrap the caller's handler so clicking the action also dismisses
          // the toast — without this, an "Undo" click would leave the toast
          // hanging until the auto-dismiss timer fires, confusingly
          // suggesting the undo hasn't happened yet.
          //
          // Dismiss order matters: we hide BEFORE invoking the handler, not
          // after. The handler often calls `showToast(...)` itself to surface
          // its outcome (e.g. ReviewQueue's Undo fires "Restored N tests").
          // If we hid in a `finally` AFTER the handler, that `hideToast()`
          // would run synchronously when the handler's promise resolves —
          // tearing down the timer + visibility flag that the follow-up
          // `showToast` just set, so the user would see no result feedback.
          // Hiding first gives the handler a clean slate.
          //
          // `await Promise.resolve(...)` lets the wrapper handle BOTH sync
          // and async onClick handlers uniformly: a sync handler that
          // throws is caught, and an async handler that rejects is awaited
          // so the rejection lands in the `catch` instead of becoming an
          // unhandled promise rejection.
          onClick: async () => {
            hideToast();
            try {
              await Promise.resolve(toast.action.onClick?.());
            } catch (err) {
              // The action handler may surface its own error toast (e.g.
              // ReviewQueue's Undo emits a partial-failure toast). Only
              // synthesize a generic one when nothing else handled it.
              // eslint-disable-next-line no-console
              console.error("Toast action handler failed:", err);
            }
          },
        } : null}
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
