/**
 * @module components/ProtectedRoute
 * @description Route guard that requires authentication.
 *
 * Wraps routes that require a signed-in user. If the user is not authenticated,
 * they are redirected to `/login` with the current location saved in state
 * so they can be sent back after sign-in.
 *
 * While the auth token is being validated (e.g. on initial page load), a
 * lightweight skeleton placeholder is shown instead of a blank screen to
 * avoid a flash of empty content on slower connections.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children - Protected child routes/components.
 * @returns {React.ReactElement}
 *
 * @example
 * <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
 *   <Route path="/dashboard" element={<Dashboard />} />
 * </Route>
 */

import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext.jsx";

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

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Show a layout-matching skeleton while validating the auth token
  if (loading) return <AuthLoadingSkeleton />;

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}
