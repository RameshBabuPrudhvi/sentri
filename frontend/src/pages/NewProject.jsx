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
    ? (
      <div className="np-field-error">
        <span className="np-field-error__badge">!</span>
        {fieldErrors[name]}
      </div>
    )
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
      <div className="np-loading">
        <Loader2 size={18} className="spin" />
        <span className="np-loading__label">Loading project…</span>
      </div>
    );
  }

  return (
    <div className="np fade-in">

      {/* Back */}
      <button className="btn btn-ghost btn-sm np__back-btn" onClick={handleBack}>
        <ArrowLeft size={14} /> Back
      </button>

      {/* Header */}
      <div className="np-header">
        <div className="np-header__row">
          <div className="np-header__icon-wrap">
            {isEdit
              ? <Pencil size={18} color="var(--accent)" />
              : <Globe size={18} color="var(--accent)" />}
          </div>
          <div>
            <h1 className="np-header__title">
              {isEdit ? "Edit Project" : "New Project"}
            </h1>
            <p className="np-header__subtitle">
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
          return (
            <div className="np-steps">
              {["Application details", "Auth (optional)", "Create"].map((s, i) => {
                const state = stepStates[i];
                return (
                  <div key={s} className={`np-step np-step--${state}`}>
                    <span className="np-step__num">
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

      <form onSubmit={submit} noValidate className="np-form">

        {/* ── Application Details ── */}
        <section className="np-section">
          <div className="np-section__head">
            <div className="np-section__head-icon">
              <Globe size={14} color="var(--accent)" />
            </div>
            <span className="np-section__head-title">Application Details</span>
          </div>

          <div className="np-section__body">
            {/* Project name */}
            <div>
              <label className="np-label">
                Project Name <span className="np-required">*</span>
              </label>
              <input
                className={`input${fieldErrors.name ? " np-input--error" : ""}`}
                value={form.name}
                onChange={set("name")}
                placeholder="e.g. My Web App"
                autoFocus={!isEdit}
              />
              <FieldError name="name" />
            </div>

            {/* URL + test button */}
            <div>
              <label className="np-label">
                Application URL <span className="np-required">*</span>
              </label>
              <div className="np-url">
                <div className="np-url__icon">
                  <Globe size={14} />
                </div>
                <input
                  className={`input np-url__input${fieldErrors.url ? " np-input--error" : ""}`}
                  value={form.url}
                  onChange={set("url")}
                  placeholder="https://example.com"
                  onBlur={() => {
                    const v = form.url.trim();
                    if (v && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) {
                      setForm(f => ({ ...f, url: "https://" + v }));
                    }
                  }}
                />
                <button
                  type="button"
                  className="np-url__test-btn"
                  onClick={testConnection}
                  disabled={testing}
                >
                  {testing
                    ? <Loader2 size={12} className="spin" />
                    : testResult?.ok
                      ? <Wifi size={12} className="np-url__test-icon--ok" />
                      : testResult
                        ? <WifiOff size={12} className="np-url__test-icon--err" />
                        : <Wifi size={12} />}
                  {testing ? "Testing…" : "Test"}
                </button>
              </div>

              {testResult && (
                <div className={`np-url__result np-url__result--${testResult.ok ? "ok" : "err"}`}>
                  {testResult.ok ? <CheckCircle2 size={12} /> : <WifiOff size={12} />}
                  {testResult.msg}
                </div>
              )}

              <FieldError name="url" />
            </div>
          </div>
        </section>

        {/* ── Authentication ── */}
        <section className={`np-section np-section--${form.hasAuth ? "auth-on" : "auth-off"}`}>
          <div className="np-section__head np-section__head--justify">
            <div className="np-section__head-title-group">
              <div className={`np-section__head-icon${form.hasAuth ? "" : " np-section__head-icon--muted"}`}>
                {form.hasAuth
                  ? <ShieldCheck size={14} color="var(--accent)" />
                  : <Lock size={14} color="var(--text3)" />}
              </div>
              <div className="np-section__head-meta">
                <div className="np-section__head-title">Authentication</div>
                <div className="np-section__head-subtitle">
                  {form.hasAuth ? "Login credentials configured" : "Does your app require login?"}
                </div>
              </div>
            </div>

            {/* Toggle switch */}
            <label className="np-toggle">
              <input
                type="checkbox"
                className="np-toggle__input"
                checked={form.hasAuth}
                onChange={toggleAuth}
              />
              <span className="np-toggle__track">
                <span className="np-toggle__thumb" />
              </span>
            </label>
          </div>

          {form.hasAuth && (
            <div className="np-section__body np-section__body--auth">
              <div className="np-auth-hint">
                <ShieldCheck size={14} className="np-auth-hint__icon" />
                <span>
                  Login form fields are detected automatically — just enter your test credentials.
                </span>
              </div>

              <div className="np-auth-grid">
                <div>
                  <label className="np-label">
                    Username / Email <span className="np-required">*</span>
                  </label>
                  <input
                    className={`input${fieldErrors.username ? " np-input--error" : ""}`}
                    value={form.username}
                    onChange={set("username")}
                    placeholder={isEdit && hasExistingCreds ? "•••••• (saved — leave blank to keep)" : "user@example.com"}
                  />
                  <FieldError name="username" />
                </div>
                <div>
                  <label className="np-label">
                    Password <span className="np-required">*</span>
                  </label>
                  <div className="np-password">
                    <input
                      className={`input np-password__input${fieldErrors.password ? " np-input--error" : ""}`}
                      type={showPassword ? "text" : "password"}
                      value={form.password}
                      onChange={set("password")}
                      placeholder={isEdit && hasExistingCreds ? "•••••• (saved — leave blank to keep)" : "••••••••"}
                    />
                    <button
                      type="button"
                      className="np-password__toggle"
                      onClick={() => setShowPassword(v => !v)}
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
          <div className="np-error-banner">
            <span className="np-error-banner__badge">!</span>
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          className="btn btn-primary np-submit"
          type="submit"
          disabled={loading}
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