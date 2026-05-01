import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  ArrowLeft, Globe, Lock, Plus, CheckCircle2, Loader2,
  Eye, EyeOff, ShieldCheck, Wifi, WifiOff, Pencil, Save,
} from "lucide-react";
import { api } from "../api.js";
import { emitTourEvent } from "../hooks/useOnboarding.js";
import usePageTitle from "../hooks/usePageTitle.js";

function validateForm(form, { isEdit = false, hasExistingCreds = false } = {}) {
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
    // Selectors are auto-detected at crawl time by the backend's
    // performAutoLogin() waterfall, so the user only needs to supply
    // credentials. In edit mode, a blank username/password means "keep
    // the existing encrypted value" (the server never returns secrets).
    const skipSecretRequired = isEdit && hasExistingCreds;
    if (!form.username.trim() && !skipSecretRequired) {
      errors.username = "Username / email is required.";
    }
    if (!form.password.trim() && !skipSecretRequired) {
      errors.password = "Password is required.";
    }
  }
  return errors;
}

const EMPTY_FORM = {
  name: "", url: "", hasAuth: false,
  username: "", password: "",
};

export default function NewProject() {
  // Support edit mode: /projects/new?edit=PRJ-1
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const editId = params.get("edit") || null;
  const isEdit = Boolean(editId);

  usePageTitle(isEdit ? "Edit Project" : "New Project");
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY_FORM);
  const [savedAuthFields, setSavedAuthFields] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(isEdit);
  // Baseline form after load — used to detect real dirtiness in edit mode.
  // In create mode it stays equal to EMPTY_FORM so any typing counts as dirty.
  const [initialForm, setInitialForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  // True when the loaded project already has credentials stored server-side.
  // The backend never returns the encrypted username/password to the client
  // (see projectSanitiser.js), so those fields arrive blank — we use this flag
  // to relax validation and show a "leave blank to keep" hint.
  const [hasExistingCreds, setHasExistingCreds] = useState(false);

  // Load existing project when editing
  useEffect(() => {
    if (!editId) return;
    setLoadingEdit(true);
    api.getProject(editId)
      .then(data => {
        const p = data.project ?? data;
        setHasExistingCreds(Boolean(p.credentials));
        const loaded = {
          name: p.name || "",
          url:  p.url  || "",
          hasAuth: Boolean(p.credentials),
          // Secrets are intentionally not returned by the API — leave blank.
          username: "",
          password: "",
        };
        setForm(loaded);
        setInitialForm(loaded);
      })
      .catch(err => setError(`Could not load project: ${err.message}`))
      .finally(() => setLoadingEdit(false));
  }, [editId]);

  const set = (k) => (e) => {
    setForm(f => ({ ...f, [k]: e.target.value }));
    if (fieldErrors[k]) setFieldErrors(fe => { const n = { ...fe }; delete n[k]; return n; });
  };

  function toggleAuth(e) {
    const checked = e.target.checked;
    if (!checked && form.hasAuth) {
      setSavedAuthFields({
        username: form.username,
        password: form.password,
      });
    }
    if (checked && savedAuthFields) {
      setForm(f => ({ ...f, hasAuth: true, ...savedAuthFields }));
      return;
    }
    setForm(f => ({ ...f, hasAuth: checked }));
  }

  async function testConnection() {
    let urlVal = form.url.trim();
    if (!urlVal) { setTestResult({ ok: false, msg: "Enter a URL first." }); return; }
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlVal)) {
      urlVal = "https://" + urlVal;
      setForm(f => ({ ...f, url: urlVal }));
    }
    try { new URL(urlVal); } catch { setTestResult({ ok: false, msg: "Invalid URL format." }); return; }
    setTesting(true);
    setTestResult(null);
    try {
      await api.testConnection(urlVal);
      setTestResult({ ok: true, msg: "URL is reachable" });
    } catch (err) {
      setTestResult({ ok: false, msg: `Could not reach URL: ${err.message}` });
    } finally {
      setTesting(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    const errors = validateForm(form, { isEdit, hasExistingCreds });
    if (Object.keys(errors).length > 0) { setFieldErrors(errors); return; }
    setFieldErrors({});
    setLoading(true);
    try {
      const payload = {
        name: form.name.trim(),
        url:  form.url.trim(),
        // Only credentials (username + password) are sent — login form
        // selectors are auto-detected at crawl time. Blank username/password
        // on edit means "keep existing"; the server merges blanks with the
        // stored encrypted values.
        credentials: form.hasAuth ? {
          username: form.username.trim(),
          password: form.password,
        } : null,
      };
      if (isEdit) {
        await api.updateProject(editId, payload);
        navigate(`/projects/${editId}`);
      } else {
        const project = await api.createProject(payload);
        emitTourEvent("project-created");
        navigate(`/projects/${project.id}`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const FieldError = ({ name }) => fieldErrors[name]
    ? <div style={{ color: "var(--red)", fontSize: "0.75rem", marginTop: 5, display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--red)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: "0.6rem", flexShrink: 0, fontWeight: 700 }}>!</span>
        {fieldErrors[name]}
      </div>
    : null;

  // Compare against the baseline (EMPTY_FORM in create mode, loaded project
  // in edit mode) so a pristine edit form doesn't trigger the leave-without-
  // saving prompt.
  const isDirty = JSON.stringify(form) !== JSON.stringify(initialForm);

  function handleBack() {
    if (isDirty && !window.confirm("Leave without saving? Your changes will be lost.")) return;
    navigate(isEdit ? `/projects/${editId}` : -1);
  }

  if (loadingEdit) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, gap: 10, color: "var(--text3)" }}>
        <Loader2 size={18} className="spin" />
        <span style={{ fontSize: "0.9rem" }}>Loading project…</span>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ maxWidth: 620, margin: "0 auto", paddingBottom: 48 }}>

      {/* Back */}
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 28, gap: 6 }} onClick={handleBack}>
        <ArrowLeft size={14} /> Back
      </button>

      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12,
            background: "var(--accent-bg)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {isEdit
              ? <Pencil size={18} color="var(--accent)" />
              : <Globe size={18} color="var(--accent)" />}
          </div>
          <div>
            <h1 style={{ fontWeight: 700, fontSize: "1.5rem", lineHeight: 1.2 }}>
              {isEdit ? "Edit Project" : "New Project"}
            </h1>
            <p style={{ color: "var(--text2)", fontSize: "0.875rem", marginTop: 2 }}>
              {isEdit ? "Update your project configuration" : "Configure your web application for autonomous testing"}
            </p>
          </div>
        </div>

        {/* Step pills — derived from form state, not hardcoded.
            Step 1 (Application details) is complete when name + a valid URL
            are present. Step 2 (Auth) is complete when the user has either
            opted out (hasAuth=false) or filled in all auth fields.
            Step 3 (Create) is active once both prior steps complete. */}
        {!isEdit && (() => {
          let urlValid = false;
          if (form.url.trim()) {
            try {
              const parsed = new URL(form.url.trim());
              urlValid = ["http:", "https:"].includes(parsed.protocol);
            } catch { /* invalid URL */ }
          }
          const step1Complete = Boolean(form.name.trim()) && urlValid;
          const authFieldsFilled = form.hasAuth
            && form.username.trim()
            && form.password.trim();
          // hasAuth=false counts as "complete" — auth is genuinely optional.
          const step2Complete = !form.hasAuth || Boolean(authFieldsFilled);
          const stepStates = [
            step1Complete ? "complete" : "active",
            step1Complete ? (step2Complete ? "complete" : "active") : "pending",
            step1Complete && step2Complete ? "active" : "pending",
          ];
          const styles = {
            complete: {
              bg: "var(--green-bg)", border: "var(--green)", text: "var(--green)",
              numBg: "var(--green)", numFg: "#fff",
            },
            active: {
              bg: "var(--accent-bg)", border: "var(--accent)", text: "var(--accent)",
              numBg: "var(--accent)", numFg: "#fff",
            },
            pending: {
              bg: "var(--bg2)", border: "var(--border)", text: "var(--text3)",
              numBg: "var(--bg3)", numFg: "var(--text3)",
            },
          };
          return (
            <div style={{ display: "flex", gap: 6, marginTop: 16 }}>
              {["Application details", "Auth (optional)", "Create"].map((s, i) => {
                const state = stepStates[i];
                const c = styles[state];
                return (
                  <div key={s} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "4px 12px", borderRadius: 999,
                    background: c.bg,
                    border: `1px solid ${c.border}`,
                    fontSize: "0.72rem", fontWeight: 500,
                    color: c.text,
                    transition: "all 0.15s",
                  }}>
                    <span style={{
                      width: 16, height: 16, borderRadius: "50%", display: "inline-flex",
                      alignItems: "center", justifyContent: "center", fontSize: "0.65rem",
                      background: c.numBg, color: c.numFg, fontWeight: 700,
                    }}>
                      {state === "complete" ? <CheckCircle2 size={11} /> : i + 1}
                    </span>
                    {s}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* ── Application Details ── */}
        <section style={{
          border: "1px solid var(--border)", borderRadius: "var(--radius-lg)",
          overflow: "hidden", background: "var(--surface)",
        }}>
          <div style={{
            padding: "14px 20px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", gap: 10,
            background: "var(--bg2)",
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8, background: "var(--accent-bg)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <Globe size={14} color="var(--accent)" />
            </div>
            <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Application Details</span>
          </div>

          <div style={{ padding: 20, display: "grid", gap: 18 }}>
            {/* Project name */}
            <div>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: "0.83rem" }}>
                Project Name <span style={{ color: "var(--red)" }}>*</span>
              </label>
              <input
                className="input"
                value={form.name}
                onChange={set("name")}
                placeholder="e.g. My Web App"
                autoFocus={!isEdit}
                style={{ borderColor: fieldErrors.name ? "var(--red)" : undefined }}
              />
              <FieldError name="name" />
            </div>

            {/* URL + test button */}
            <div>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: "0.83rem" }}>
                Application URL <span style={{ color: "var(--red)" }}>*</span>
              </label>
              <div style={{ position: "relative" }}>
                <div style={{
                  position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
                  color: "var(--text3)", pointerEvents: "none",
                }}>
                  <Globe size={14} />
                </div>
                <input
                  className="input"
                  value={form.url}
                  onChange={set("url")}
                  placeholder="https://example.com"
                  onBlur={() => {
                    const v = form.url.trim();
                    if (v && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) {
                      setForm(f => ({ ...f, url: "https://" + v }));
                    }
                  }}
                  style={{
                    paddingLeft: 36, paddingRight: 100,
                    borderColor: fieldErrors.url ? "var(--red)" : undefined,
                  }}
                />
                <button
                  type="button"
                  onClick={testConnection}
                  disabled={testing}
                  style={{
                    position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "4px 10px", borderRadius: 6,
                    border: "1px solid var(--border)", background: "var(--surface)",
                    cursor: "pointer", fontSize: "0.75rem", fontWeight: 500,
                    color: testing ? "var(--text3)" : "var(--text2)",
                    transition: "all 0.12s",
                  }}
                >
                  {testing
                    ? <Loader2 size={12} className="spin" />
                    : testResult?.ok
                      ? <Wifi size={12} style={{ color: "var(--green)" }} />
                      : testResult
                        ? <WifiOff size={12} style={{ color: "var(--red)" }} />
                        : <Wifi size={12} />}
                  {testing ? "Testing…" : "Test"}
                </button>
              </div>

              {/* Test result pill */}
              {testResult && (
                <div style={{
                  marginTop: 8, display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "4px 10px", borderRadius: 999,
                  background: testResult.ok ? "var(--green-bg)" : "var(--red-bg)",
                  border: `1px solid ${testResult.ok ? "var(--green)" : "var(--red)"}`,
                  fontSize: "0.73rem", fontWeight: 500,
                  color: testResult.ok ? "var(--green)" : "var(--red)",
                }}>
                  {testResult.ok ? <CheckCircle2 size={12} /> : <WifiOff size={12} />}
                  {testResult.msg}
                </div>
              )}

              <FieldError name="url" />
            </div>
          </div>
        </section>

        {/* ── Authentication ── */}
        <section style={{
          border: `1px solid ${form.hasAuth ? "var(--accent)" : "var(--border)"}`,
          borderRadius: "var(--radius-lg)", overflow: "hidden",
          background: "var(--surface)",
          transition: "border-color 0.15s",
        }}>
          <div style={{
            padding: "14px 20px",
            borderBottom: form.hasAuth ? "1px solid var(--border)" : "none",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: form.hasAuth ? "var(--bg2)" : "transparent",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 28, height: 28, borderRadius: 8,
                background: form.hasAuth ? "var(--accent-bg)" : "var(--bg3)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {form.hasAuth
                  ? <ShieldCheck size={14} color="var(--accent)" />
                  : <Lock size={14} color="var(--text3)" />}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>Authentication</div>
                <div style={{ color: "var(--text3)", fontSize: "0.75rem" }}>
                  {form.hasAuth ? "Login credentials configured" : "Does your app require login?"}
                </div>
              </div>
            </div>

            {/* Toggle switch */}
            <label style={{
              position: "relative", width: 42, height: 24, cursor: "pointer", flexShrink: 0,
            }}>
              <input
                type="checkbox"
                checked={form.hasAuth}
                onChange={toggleAuth}
                style={{ opacity: 0, width: 0, height: 0, position: "absolute" }}
              />
              <span style={{
                position: "absolute", inset: 0, borderRadius: 999, transition: "background 0.2s",
                background: form.hasAuth ? "var(--accent)" : "var(--bg3)",
                border: `1px solid ${form.hasAuth ? "var(--accent)" : "var(--border)"}`,
              }}>
                <span style={{
                  position: "absolute", top: 2, left: form.hasAuth ? 20 : 2,
                  width: 18, height: 18, borderRadius: "50%",
                  background: form.hasAuth ? "#fff" : "var(--text3)",
                  transition: "left 0.2s",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                }} />
              </span>
            </label>
          </div>

          {form.hasAuth && (
            <div style={{ padding: 20, display: "grid", gap: 14 }}>
              {/* Auto-detect hint */}
              <div style={{
                padding: "10px 12px", borderRadius: "var(--radius)",
                background: "var(--accent-bg)", border: "1px solid var(--accent)",
                fontSize: "0.78rem", color: "var(--accent)",
                display: "flex", alignItems: "flex-start", gap: 8,
              }}>
                <ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  Sentri detects login form fields automatically — just enter your test credentials.
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: "0.83rem" }}>
                    Username / Email <span style={{ color: "var(--red)" }}>*</span>
                  </label>
                  <input className="input" value={form.username} onChange={set("username")}
                    placeholder={isEdit && hasExistingCreds ? "•••••• (saved — leave blank to keep)" : "user@example.com"}
                    style={{ borderColor: fieldErrors.username ? "var(--red)" : undefined }} />
                  <FieldError name="username" />
                </div>
                <div>
                  <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: "0.83rem" }}>
                    Password <span style={{ color: "var(--red)" }}>*</span>
                  </label>
                  <div style={{ position: "relative" }}>
                    <input
                      className="input"
                      type={showPassword ? "text" : "password"}
                      value={form.password}
                      onChange={set("password")}
                      placeholder={isEdit && hasExistingCreds ? "•••••• (saved — leave blank to keep)" : "••••••••"}
                      style={{ paddingRight: 38, borderColor: fieldErrors.password ? "var(--red)" : undefined }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      style={{
                        position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                        background: "none", border: "none", cursor: "pointer", color: "var(--text3)",
                        padding: 2,
                      }}
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <FieldError name="password" />
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Error banner */}
        {error && (
          <div style={{
            padding: "12px 16px", borderRadius: "var(--radius)",
            background: "var(--red-bg)", border: "1px solid var(--red)",
            color: "var(--red)", fontSize: "0.875rem", display: "flex", alignItems: "flex-start", gap: 8,
          }}>
            <span style={{
              width: 16, height: 16, borderRadius: "50%", background: "var(--red)", color: "#fff",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontSize: "0.65rem", fontWeight: 700, flexShrink: 0, marginTop: 1,
            }}>!</span>
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          className="btn btn-primary"
          type="submit"
          disabled={loading}
          style={{
            width: "100%", justifyContent: "center",
            padding: "13px", fontSize: "0.9rem", fontWeight: 600,
            borderRadius: "var(--radius)", gap: 8,
          }}
        >
          {loading
            ? <Loader2 size={16} className="spin" />
            : isEdit ? <Save size={16} /> : <Plus size={16} />}
          {loading
            ? (isEdit ? "Saving…" : "Creating…")
            : (isEdit ? "Save Changes" : "Create Project")}
        </button>
      </form>
    </div>
  );
}