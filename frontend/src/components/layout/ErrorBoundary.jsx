/**
 * ErrorBoundary — Global React error boundary.
 *
 * Catches any rendering error in the component tree below it and
 * displays a recovery UI instead of a blank white screen.
 *
 * Usage:
 *   Wrap the router (or any subtree) with <ErrorBoundary>.
 *   This is a class component because React's error boundary API
 *   (`getDerivedStateFromError` / `componentDidCatch`) is only available
 *   on class components.
 */

import React from "react";

/**
 * @typedef {Object} ErrorBoundaryState
 * @property {Error|null} error   - The caught error, or null when healthy.
 * @property {string|null} info   - React component stack from componentDidCatch.
 */

export default class ErrorBoundary extends React.Component {
  /**
   * @param {Object} props
   * @param {React.ReactNode} props.children
   */
  constructor(props) {
    super(props);
    /** @type {ErrorBoundaryState} */
    this.state = { error: null, info: null };
  }

  /**
   * Derive error state from a caught rendering error.
   * Called synchronously during render so the fallback UI can be shown
   * on the same paint as the crash.
   *
   * @param {Error} error
   * @returns {ErrorBoundaryState}
   */
  static getDerivedStateFromError(error) {
    return { error, info: null };
  }

  /**
   * Log the error and component stack after the boundary has caught it.
   * Safe to call side effects here (analytics, logging endpoints, etc.).
   *
   * @param {Error}                  error
   * @param {React.ErrorInfo}        errorInfo
   * @param {string}                 errorInfo.componentStack
   */
  componentDidCatch(error, errorInfo) {
    this.setState({ info: errorInfo?.componentStack ?? null });

    // Log to the server so crashes surface in backend logs even when
    // the user doesn't report them. Failures are silently swallowed so
    // the error boundary itself never throws.
    try {
      fetch("/api/system/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: error?.message ?? String(error),
          stack: error?.stack ?? null,
          componentStack: errorInfo?.componentStack ?? null,
          url: window.location.href,
        }),
      }).catch(() => {
        // Intentionally ignored — the server may also be down.
      });
    } catch {
      // Intentionally ignored.
    }
  }

  /** Reset the boundary so the user can try again without a hard reload. */
  handleReset() {
    this.setState({ error: null, info: null });
  }

  render() {
    const { error } = this.state;

    if (error) {
      return (
        <div
          style={{
            padding: "80px 40px",
            textAlign: "center",
            color: "var(--text2)",
            maxWidth: 520,
            margin: "0 auto",
          }}
        >
          <div style={{ fontSize: "2.5rem", marginBottom: 16 }}>💥</div>
          <div
            style={{
              fontWeight: 700,
              fontSize: "1.2rem",
              color: "var(--text)",
              marginBottom: 8,
            }}
          >
            Something went wrong
          </div>
          <div
            style={{
              fontSize: "0.875rem",
              marginBottom: 24,
              lineHeight: 1.6,
              color: "var(--text2)",
            }}
          >
            {error?.message || "An unexpected error occurred."}
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => this.handleReset()}
            >
              Try again
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                window.location.href =
                  (import.meta.env.BASE_URL ?? "/") + "dashboard";
              }}
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
