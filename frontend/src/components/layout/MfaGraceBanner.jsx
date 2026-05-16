import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, X } from "lucide-react";

/**
 * SEC-004 — Workspace MFA grace-period banner.
 *
 * The backend sets `X-MFA-Grace-Period-Days-Remaining` and `X-MFA-Grace-Ends-At`
 * on a successful `/login` (and OAuth callbacks) when the workspace requires
 * MFA but the user is still inside the grace window. `Login.jsx` reads those
 * headers and writes `sessionStorage["mfa_grace_banner"]` so this banner can
 * render after the post-login navigation without depending on a header that
 * only exists on the original response.
 *
 * The user can dismiss the banner for the current session (no localStorage —
 * we want them to see it again next sign-in until they actually enroll).
 *
 * @returns {JSX.Element|null}
 */
export default function MfaGraceBanner() {
  const navigate = useNavigate();
  const [banner, setBanner] = useState(() => {
    try {
      const raw = sessionStorage.getItem("mfa_grace_banner");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Dismissed during this session — keep hidden until next login.
      if (parsed.dismissed) return null;
      return parsed;
    } catch {
      return null;
    }
  });

  // If the user enrolls in MFA mid-session, Settings.jsx will clear the key
  // and we want the banner to disappear immediately. Re-read sessionStorage
  // on focus so the banner stays in sync without a heavy global state.
  useEffect(() => {
    function onFocus() {
      try {
        const raw = sessionStorage.getItem("mfa_grace_banner");
        if (!raw) { setBanner(null); return; }
        const parsed = JSON.parse(raw);
        if (parsed.dismissed) { setBanner(null); return; }
        setBanner(parsed);
      } catch { /* sessionStorage unavailable */ }
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (!banner) return null;

  function handleDismiss() {
    try {
      sessionStorage.setItem("mfa_grace_banner", JSON.stringify({
        ...banner,
        dismissed: true,
      }));
    } catch { /* sessionStorage unavailable */ }
    setBanner(null);
  }

  const days = Number(banner.daysRemaining) || 0;
  const isUrgent = days <= 1;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`grace-banner ${isUrgent ? "grace-banner--urgent" : "grace-banner--warn"}`}
    >
      <AlertTriangle size={16} color={isUrgent ? "var(--danger)" : "var(--amber)"} />
      <div className="grace-banner__body">
        <strong>Multi-factor authentication required:</strong>{" "}
        Your workspace requires MFA. You have <strong>{days}</strong> day{days === 1 ? "" : "s"} remaining
        to enroll before sign-in is blocked.
      </div>
      <button
        className="btn btn-primary btn-sm"
        onClick={() => navigate("/settings?tab=security")}
      >
        Set up now
      </button>
      <button
        className="btn btn-ghost btn-xs"
        onClick={handleDismiss}
        aria-label="Dismiss MFA grace period banner"
        title="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  );
}
