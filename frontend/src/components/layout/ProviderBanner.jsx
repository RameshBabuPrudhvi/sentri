/**
 * ProviderBanner — Global sticky banner shown when no AI provider is configured.
 *
 * Calls `GET /api/config` on mount. If `hasProvider === false`, renders an
 * amber warning banner with a "Configure API Key" link to Settings.
 * Dismissible per-session via `sessionStorage` keyed to the current user ID
 * so it re-appears on next login.
 *
 * @param {{ userId: string|undefined }} props
 */

import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Settings, X } from "lucide-react";
import { api } from "../../api.js";

const DISMISS_KEY = (uid) => `sentri_provider_banner_dismissed_${uid || "anon"}`;

export default function ProviderBanner({ userId }) {
  const [show, setShow] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // Skip if already dismissed this session
    if (sessionStorage.getItem(DISMISS_KEY(userId))) return;

    api.getConfig()
      .then((cfg) => {
        if (!cfg?.hasProvider) setShow(true);
      })
      .catch(() => { /* network error — don't block the UI */ });
  }, [userId]);

  if (!show) return null;

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY(userId), "1");
    setShow(false);
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        background: "var(--amber-bg)",
        border: "1px solid #fcd34d",
        borderRadius: 0,
        fontSize: "0.82rem",
        color: "#92400e",
        lineHeight: 1.5,
      }}
    >
      <AlertTriangle size={14} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        <strong>No AI provider configured.</strong>{" "}
        Sentri needs an API key (Anthropic, OpenAI, Google) or a local Ollama server to generate and heal tests.
      </span>
      <button
        onClick={() => { dismiss(); navigate("/settings"); }}
        className="btn btn-sm"
        style={{
          background: "rgba(255,255,255,0.5)",
          border: "1px solid #fcd34d",
          color: "#92400e",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        <Settings size={11} /> Configure API Key
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "#92400e",
          padding: 2,
          flexShrink: 0,
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
