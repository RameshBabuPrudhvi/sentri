import React from "react";
import { Shield } from "lucide-react";

/**
 * Defence-in-depth UI gate — rendered when a non-admin reaches an
 * admin-only settings section via stale state, deep link, or direct URL.
 * Backend mutation routes still enforce `requireRole("admin")` as the
 * authoritative ACL; this is purely a friendlier UI than a 403 toast.
 * Extracted from Settings.jsx (GAP-002).
 */
export default function AdminLockedSection({ feature, role }) {
  return (
    <div className="card card-padded st-admin-locked">
      <Shield size={28} color="var(--text3)" className="st-admin-locked__icon" />
      <div className="font-bold st-admin-locked__title">
        {feature} requires admin access
      </div>
      <div className="text-sm text-muted st-admin-locked__body">
        Your current role is <strong>{role || "viewer"}</strong>. Ask a workspace admin to grant you
        the <strong>admin</strong> role if you need to change these settings.
      </div>
    </div>
  );
}
