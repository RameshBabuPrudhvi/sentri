import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AppLogo from "../components/AppLogo.jsx";
import { API_BASE, parseJsonResponse } from "../utils/api.js";
import usePageTitle from "../hooks/usePageTitle.js";

function Spinner() {
  return (
    <svg style={{animation:'spin 0.8s linear infinite',display:'inline-block'}} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.2"/>
      <path d="M12 2a10 10 0 0 1 10 10"/>
    </svg>
  );
}

function EyeIcon({ open }) {
  if (open) return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>;
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>;
}

const S = {
  root: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#060810", fontFamily: "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif", padding: 24 },
  card: { width: "100%", maxWidth: 400, background: "#0d1117", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 16, padding: "40px 36px" },
  logo: { marginBottom: 28, textAlign: "center" },
  title: { fontFamily: "'Syne',sans-serif", fontSize: "1.4rem", fontWeight: 700, color: "#f1f5f9", margin: "0 0 6px", letterSpacing: "-0.5px", textAlign: "center" },
  sub: { fontSize: "0.85rem", color: "#64748b", margin: "0 0 24px", textAlign: "center", lineHeight: 1.6 },
  field: { marginBottom: 16 },
  lbl: { display: "block", fontSize: "0.78rem", fontWeight: 500, color: "#64748b", letterSpacing: "0.3px", marginBottom: 7 },
  input: { width: "100%", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#f1f5f9", fontSize: "0.875rem", fontFamily: "inherit", outline: "none", boxSizing: "border-box" },
  inputPw: { width: "100%", padding: "10px 42px 10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#f1f5f9", fontSize: "0.875rem", fontFamily: "inherit", outline: "none", boxSizing: "border-box" },
  iw: { position: "relative" },
  eye: { position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#334155", display: "flex", alignItems: "center", padding: 2 },
  alertErr: { display: "flex", alignItems: "flex-start", gap: 9, borderRadius: 10, padding: "11px 13px", fontSize: "0.82rem", lineHeight: 1.5, marginBottom: 16, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", color: "#fca5a5" },
  alertOk: { display: "flex", alignItems: "flex-start", gap: 9, borderRadius: 10, padding: "11px 13px", fontSize: "0.82rem", lineHeight: 1.5, marginBottom: 16, background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.2)", color: "#86efac" },
  btn: { width: "100%", padding: "11px 16px", borderRadius: 10, border: "none", background: "linear-gradient(135deg,#6366f1,#7c3aed)", color: "#fff", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontFamily: "inherit", boxShadow: "0 4px 20px rgba(99,102,241,0.35)", marginTop: 4 },
  back: { display: "block", textAlign: "center", marginTop: 20, fontSize: "0.82rem", color: "#818cf8", textDecoration: "none", fontWeight: 500 },
  strRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 8 },
  strTrack: { flex: 1, height: 3, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" },
  mismatch: { fontSize: "0.75rem", color: "#f87171", marginTop: 6 },
};

export default function ForgotPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const mode = token ? "reset" : "request";
  usePageTitle(mode === "reset" ? "Set new password" : "Reset password");

  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function handleRequest(e) {
    e.preventDefault(); setError(""); setSuccess("");
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setError("Please enter a valid email address."); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/forgot-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setSuccess(data.message || "If an account with that email exists, a reset link has been generated.");
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleReset(e) {
    e.preventDefault(); setError(""); setSuccess("");
    if (newPassword.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (newPassword !== confirmPassword) { setError("Passwords do not match."); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/reset-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, newPassword }) });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setSuccess(data.message || "Password has been reset successfully.");
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  const strength = (() => {
    if (!newPassword) return null;
    let s = 0;
    if (newPassword.length >= 8) s++; if (newPassword.length >= 12) s++;
    if (/[A-Z]/.test(newPassword)) s++; if (/[0-9]/.test(newPassword)) s++;
    if (/[^A-Za-z0-9]/.test(newPassword)) s++;
    if (s <= 1) return { label: "Weak", color: "#f87171", pct: "20%" };
    if (s <= 2) return { label: "Fair", color: "#fb923c", pct: "45%" };
    if (s <= 3) return { label: "Good", color: "#facc15", pct: "70%" };
    return { label: "Strong", color: "#4ade80", pct: "100%" };
  })();

  const pwMismatch = confirmPassword && newPassword !== confirmPassword;

  return (
    <div style={S.root}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={S.card}>
        <div style={S.logo}><AppLogo size={36} variant="full" color="#f1f5f9" /></div>

        {mode === "request" ? (
          <>
            <h1 style={S.title}>Reset your password</h1>
            <p style={S.sub}>Enter the email address associated with your account and we'll generate a password reset link.</p>
            {error && <div style={S.alertErr} role="alert">{error}</div>}
            {success && <div style={S.alertOk} role="status">{success}</div>}
            <form onSubmit={handleRequest} noValidate>
              <div style={S.field}>
                <label style={S.lbl} htmlFor="fp-email">Email address</label>
                <input id="fp-email" type="email" style={S.input} placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required disabled={loading} />
              </div>
              <button type="submit" style={{...S.btn, opacity: loading ? 0.5 : 1}} disabled={loading}>{loading && <Spinner />}{loading ? "Sending…" : "Send reset link"}</button>
            </form>
          </>
        ) : (
          <>
            <h1 style={S.title}>Set new password</h1>
            <p style={S.sub}>Enter your new password below. Must be at least 8 characters.</p>
            {error && <div style={S.alertErr} role="alert">{error}</div>}
            {success && <div style={S.alertOk} role="status">{success}</div>}
            {!success ? (
              <form onSubmit={handleReset} noValidate>
                <div style={S.field}>
                  <label style={S.lbl} htmlFor="fp-pw">New password</label>
                  <div style={S.iw}>
                    <input id="fp-pw" type={showPassword ? "text" : "password"} style={S.inputPw} placeholder="Min. 8 characters" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" required disabled={loading} minLength={8} />
                    <button type="button" style={S.eye} onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? "Hide password" : "Show password"}><EyeIcon open={showPassword} /></button>
                  </div>
                  {strength && <div style={S.strRow}><div style={S.strTrack}><div style={{height:"100%",borderRadius:2,width:strength.pct,background:strength.color,transition:"width 0.4s"}}/></div><span style={{fontSize:"0.7rem",fontWeight:600,minWidth:38,textAlign:"right",color:strength.color}}>{strength.label}</span></div>}
                </div>
                <div style={S.field}>
                  <label style={S.lbl} htmlFor="fp-confirm">Confirm password</label>
                  <input id="fp-confirm" type={showPassword ? "text" : "password"} style={S.input} placeholder="Re-enter your password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" required disabled={loading} />
                  {pwMismatch && <div style={S.mismatch}>Passwords do not match.</div>}
                </div>
                <button type="submit" style={{...S.btn, opacity: loading || pwMismatch ? 0.5 : 1}} disabled={loading || !!pwMismatch}>{loading && <Spinner />}{loading ? "Resetting…" : "Reset password"}</button>
              </form>
            ) : (
              <Link to="/login" style={{...S.back, marginTop: 0}}>Sign in with your new password →</Link>
            )}
          </>
        )}

        <Link to="/login" style={S.back}>← Back to sign in</Link>
      </div>
    </div>
  );
}
