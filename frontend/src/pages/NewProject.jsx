import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Globe, Lock, Plus, CheckCircle2, Loader2 } from "lucide-react";
import { api } from "../api.js";

// Robust URL validation + required auth field enforcement
function validateForm(form) {
  const errors = {};
  if (!form.name.trim()) errors.name = "Project name is required.";
  if (!form.url.trim()) {
    errors.url = "Application URL is required.";
  } else {
    try {
      const parsed = new URL(form.url.trim());
      if (!["http:", "https:"].includes(parsed.protocol)) {
        errors.url = "URL must start with http:// or https://";
      }
    } catch {
      errors.url = "Please enter a valid URL (e.g. https://example.com)";
    }
  }
  if (form.hasAuth) {
    if (!form.usernameSelector.trim()) errors.usernameSelector = "Username selector is required.";
    if (!form.username.trim())         errors.username         = "Username / email is required.";
    if (!form.passwordSelector.trim()) errors.passwordSelector = "Password selector is required.";
    if (!form.password.trim())         errors.password         = "Password is required.";
    if (!form.submitSelector.trim())   errors.submitSelector   = "Submit button selector is required.";
  }
  return errors;
}

export default function NewProject() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "", url: "", hasAuth: false,
    usernameSelector: "", username: "",
    passwordSelector: "", password: "", submitSelector: "",
  });
  // Preserve auth field values when toggling checkbox
  const [savedAuthFields, setSavedAuthFields] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Connection test
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const set = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    if (fieldErrors[k]) setFieldErrors(fe => { const n = { ...fe }; delete n[k]; return n; });
  };

  // Warn before discarding auth fields
  function toggleAuth(e) {
    const checked = e.target.checked;
    if (!checked && form.hasAuth) {
      // Save current values so they can be restored
      setSavedAuthFields({
        usernameSelector: form.usernameSelector,
        username: form.username,
        passwordSelector: form.passwordSelector,
        password: form.password,
        submitSelector: form.submitSelector,
      });
    }
    if (checked && savedAuthFields) {
      // Restore previously entered values
      setForm(f => ({ ...f, hasAuth: true, ...savedAuthFields }));
      return;
    }
    setForm(f => ({ ...f, hasAuth: checked }));
  }

  async function testConnection() {
    const urlVal = form.url.trim();
    if (!urlVal) { setTestResult({ ok: false, msg: "Enter a URL first." }); return; }
    try { new URL(urlVal); } catch { setTestResult({ ok: false, msg: "Invalid URL format." }); return; }
    setTesting(true);
    setTestResult(null);
    try {
      await api.testConnection(urlVal);
      setTestResult({ ok: true, msg: "URL is reachable." });
    } catch (err) {
      setTestResult({ ok: false, msg: `Could not reach URL: ${err.message}` });
    } finally {
      setTesting(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    const errors = validateForm(form);
    if (Object.keys(errors).length > 0) { setFieldErrors(errors); return; }
    setFieldErrors({});
    setLoading(true);
    try {
      const payload = {
        name: form.name.trim(),
        url: form.url.trim(),
        credentials: form.hasAuth ? {
          usernameSelector: form.usernameSelector.trim(),
          username: form.username.trim(),
          passwordSelector: form.passwordSelector.trim(),
          password: form.password,
          submitSelector: form.submitSelector.trim(),
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

  const FieldError = ({ name }) => fieldErrors[name]
    ? <div style={{ color: "var(--red)", fontSize: "0.75rem", marginTop: 4 }}>{fieldErrors[name]}</div>
    : null;

  return (
    <div className="fade-in" style={{ maxWidth: 640, margin: "0 auto" }}>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 24 }} onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>

      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.9rem" }}>New Project</h1>
        <p style={{ color: "var(--text2)", marginTop: 6 }}>Configure your web application for autonomous testing</p>
      </div>

      <form onSubmit={submit} noValidate>
        {/* Basic Info */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <Globe size={16} color="var(--accent)" />
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}>Application Details</span>
          </div>
          <div style={{ display: "grid", gap: 16 }}>
            <div>
              <label>Project Name</label>
              <input className="input" value={form.name} onChange={set("name")} placeholder="My Web App"
                style={{ borderColor: fieldErrors.name ? "var(--red)" : undefined }} />
              <FieldError name="name" />
            </div>
            <div>
              <label>Application URL</label>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <input className="input" value={form.url} onChange={set("url")} placeholder="https://example.com"
                    onBlur={() => {
                      const v = form.url.trim();
                      if (v && !v.startsWith("http://") && !v.startsWith("https://")) {
                        setForm(f => ({ ...f, url: "https://" + v }));
                      }
                    }}
                    style={{ borderColor: fieldErrors.url ? "var(--red)" : undefined }} />
                  <FieldError name="url" />
                </div>
                {/* Fix #19: test connection button */}
                <button type="button" className="btn btn-ghost btn-sm" onClick={testConnection} disabled={testing} style={{ flexShrink: 0, marginTop: 0 }}>
                  {testing ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
                  Test
                </button>
              </div>
              {testResult && (
                <div style={{ fontSize: "0.75rem", marginTop: 5, color: testResult.ok ? "var(--green)" : "var(--red)" }}>
                  {testResult.ok ? "✓ " : "✗ "}{testResult.msg}
                </div>
              )}
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
              <input type="checkbox" checked={form.hasAuth} onChange={toggleAuth} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} />
              Enable
            </label>
          </div>

          {form.hasAuth && (
            <div style={{ marginTop: 20, display: "grid", gap: 12 }}>
              <div style={{ height: 1, background: "var(--border)" }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label>Username Selector <span style={{ color: "var(--red)" }}>*</span></label>
                  <input className="input" value={form.usernameSelector} onChange={set("usernameSelector")} placeholder="#email or input[name=email]"
                    style={{ borderColor: fieldErrors.usernameSelector ? "var(--red)" : undefined }} />
                  <FieldError name="usernameSelector" />
                </div>
                <div>
                  <label>Username / Email <span style={{ color: "var(--red)" }}>*</span></label>
                  <input className="input" value={form.username} onChange={set("username")} placeholder="user@example.com"
                    style={{ borderColor: fieldErrors.username ? "var(--red)" : undefined }} />
                  <FieldError name="username" />
                </div>
                <div>
                  <label>Password Selector <span style={{ color: "var(--red)" }}>*</span></label>
                  <input className="input" value={form.passwordSelector} onChange={set("passwordSelector")} placeholder="#password or input[type=password]"
                    style={{ borderColor: fieldErrors.passwordSelector ? "var(--red)" : undefined }} />
                  <FieldError name="passwordSelector" />
                </div>
                <div>
                  <label>Password <span style={{ color: "var(--red)" }}>*</span></label>
                  <input className="input" type="password" value={form.password} onChange={set("password")} placeholder="••••••••"
                    style={{ borderColor: fieldErrors.password ? "var(--red)" : undefined }} />
                  <FieldError name="password" />
                </div>
              </div>
              <div>
                <label>Submit Button Selector <span style={{ color: "var(--red)" }}>*</span></label>
                <input className="input" value={form.submitSelector} onChange={set("submitSelector")} placeholder="button[type=submit] or #login-btn"
                  style={{ borderColor: fieldErrors.submitSelector ? "var(--red)" : undefined }} />
                <FieldError name="submitSelector" />
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
