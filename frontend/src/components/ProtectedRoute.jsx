/**
 * @module components/ProtectedRoute
 * @description Route guard that requires authentication.
 *
 * Wraps routes that require a signed-in user. If the user is not authenticated,
 * they are redirected to `/login` with the current location saved in state
 * so they can be sent back after sign-in.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children - Protected child routes/components.
 * @returns {React.ReactElement|null}
 *
 * @example
 * <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
 *   <Route path="/dashboard" element={<Dashboard />} />
 * </Route>
 */

import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  // While we check localStorage / validate the token, render nothing
  if (loading) return null;

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}
