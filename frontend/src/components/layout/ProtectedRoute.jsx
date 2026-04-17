/**
 * @module components/ProtectedRoute
 * @description Route guard that requires authentication and optional role check.
 *
 * Wraps routes that require a signed-in user. If the user is not authenticated,
 * they are redirected to `/login` with the current location saved in state
 * so they can be sent back after sign-in.
 *
 * ### Role-based guarding (ACL-002)
 * Pass `requiredRole` to restrict access by workspace role.
 * Role hierarchy: `admin > qa_lead > viewer`.
 *
 * While the auth token is being validated (e.g. on initial page load), a
 * lightweight skeleton placeholder is shown instead of a blank screen to
 * avoid a flash of empty content on slower connections.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children - Protected child routes/components.
 * @param {string} [props.requiredRole] - Minimum workspace role ('admin' | 'qa_lead' | 'viewer').
 * @returns {React.ReactElement}
 *
 * @example
 * <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
 *   <Route path="/dashboard" element={<Dashboard />} />
 * </Route>
 *
 * // Role-gated route:
 * <Route element={<ProtectedRoute requiredRole="admin"><Settings /></ProtectedRoute>} />
 */

import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";
import { hasMinimumRole } from "../../utils/roles.js";

function AuthLoadingSkeleton() {
  return (
    <div style={{
      display: "flex", minHeight: "100vh", background: "var(--bg2)",
    }}>
      {/* Sidebar skeleton */}
      <div style={{
        width: 192, background: "var(--surface)", borderRight: "1px solid var(--border)",
        flexShrink: 0, padding: "16px 12px",
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        <div className="skeleton" style={{ height: 28, width: 120, borderRadius: 8, marginBottom: 12 }} />
        {[...Array(6)].map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 32, borderRadius: 6 }} />
        ))}
      </div>
      {/* Main content skeleton */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {/* Top bar skeleton */}
        <div style={{
          height: 52, background: "var(--surface)", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", padding: "0 24px", gap: 12,
        }}>
          <div className="skeleton" style={{ height: 34, width: 280, borderRadius: 8 }} />
          <div style={{ flex: 1 }} />
          <div className="skeleton" style={{ height: 28, width: 28, borderRadius: "50%" }} />
        </div>
        {/* Page content skeleton */}
        <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="skeleton" style={{ height: 80, borderRadius: 12 }} />
          <div className="skeleton" style={{ height: 300, borderRadius: 12 }} />
        </div>
      </div>
    </div>
  );
}

export default function ProtectedRoute({ children, requiredRole }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Show a layout-matching skeleton while validating the auth token
  if (loading) return <AuthLoadingSkeleton />;

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // ACL-002: Role-based access check
  if (requiredRole && !hasMinimumRole(user.workspaceRole, requiredRole)) {
    return (
      <div style={{ padding: "80px 0", textAlign: "center", color: "var(--text2)" }}>
        <div style={{ fontSize: "3rem", marginBottom: 16 }}>403</div>
        <div style={{ fontWeight: 700, fontSize: "1.2rem", color: "var(--text)", marginBottom: 8 }}>
          Access Denied
        </div>
        <div style={{ fontSize: "0.875rem", marginBottom: 24 }}>
          This page requires <strong>{requiredRole}</strong> permissions.
          Your current role is <strong>{user.workspaceRole || "viewer"}</strong>.
        </div>
      </div>
    );
  }

  return children;
}

// Re-export for backward compatibility — prefer importing from utils/roles.js directly.
export { userHasRole } from "../../utils/roles.js";
