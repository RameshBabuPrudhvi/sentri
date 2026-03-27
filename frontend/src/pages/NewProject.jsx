import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Globe, Lock, Plus } from "lucide-react";
import { api } from "../api.js";

export default function NewProject() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", url: "", hasAuth: false, usernameSelector: "", username: "", passwordSelector: "", password: "", submitSelector: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setCheck = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.checked }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = {
        name: form.name,
        url: form.url,
        credentials: form.hasAuth ? {
          usernameSelector: form.usernameSelector,
          username: form.username,
          passwordSelector: form.passwordSelector,
          password: form.password,
          submitSelector: form.submitSelector,
        } : null,
      };
      const project = await api.createProject(payload);
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fade-in" style={{ maxWidth: 640, margin: "0 auto" }}>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 24 }} onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>

      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.9rem" }}>New Project</h1>
        <p style={{ color: "var(--text2)", marginTop: 6 }}>Configure your web application for autonomous testing</p>
      </div>

      <form onSubmit={submit}>
        {/* Basic Info */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <Globe size={16} color="var(--accent)" />
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}>Application Details</span>
          </div>
          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <label>Project Name</label>
              <input className="input" value={form.name} onChange={set("name")} placeholder="My Web App" required />
            </div>
            <div>
              <label>Application URL</label>
              <input className="input" value={form.url} onChange={set("url")} placeholder="https://example.com" type="url" required />
            </div>
          </div>
        </div>

        {/* Auth Toggle */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Lock size={16} color={form.hasAuth ? "var(--accent)" : "var(--text3)"} />
              <div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}>Authentication</div>
                <div style={{ color: "var(--text2)", fontSize: "0.82rem" }}>Does your app require login?</div>
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", textTransform: "none", fontSize: "0.875rem" }}>
              <input type="checkbox" checked={form.hasAuth} onChange={setCheck("hasAuth")} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} />
              Enable
            </label>
          </div>

          {form.hasAuth && (
            <div style={{ marginTop: 20, display: "grid", gap: 12 }}>
              <div style={{ height: 1, background: "var(--border)" }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label>Username Selector</label>
                  <input className="input" value={form.usernameSelector} onChange={set("usernameSelector")} placeholder="#email or input[name=email]" />
                </div>
                <div>
                  <label>Username / Email</label>
                  <input className="input" value={form.username} onChange={set("username")} placeholder="user@example.com" />
                </div>
                <div>
                  <label>Password Selector</label>
                  <input className="input" value={form.passwordSelector} onChange={set("passwordSelector")} placeholder="#password or input[type=password]" />
                </div>
                <div>
                  <label>Password</label>
                  <input className="input" type="password" value={form.password} onChange={set("password")} placeholder="••••••••" />
                </div>
              </div>
              <div>
                <label>Submit Button Selector</label>
                <input className="input" value={form.submitSelector} onChange={set("submitSelector")} placeholder="button[type=submit] or #login-btn" />
              </div>
            </div>
          )}
        </div>

        {error && (
          <div style={{ padding: "12px 16px", background: "rgba(255,71,87,0.08)", border: "1px solid rgba(255,71,87,0.2)", borderRadius: "var(--radius)", color: "var(--red)", fontSize: "0.875rem", marginBottom: 16 }}>
            {error}
          </div>
        )}

        <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: "100%", justifyContent: "center", padding: "12px" }}>
          {loading ? <span className="spin" style={{ display: "inline-block", width: 16, height: 16, border: "2px solid #000", borderTopColor: "transparent", borderRadius: "50%" }} /> : <Plus size={16} />}
          {loading ? "Creating…" : "Create Project"}
        </button>
      </form>
    </div>
  );
}
