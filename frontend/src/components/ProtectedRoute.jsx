/**
 * ProtectedRoute.jsx
 *
 * Wraps routes that require an authenticated user.
 * If the user is not logged in they are redirected to /login,
 * and the current location is saved so they can be sent back after login.
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
