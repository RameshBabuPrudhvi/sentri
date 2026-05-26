/**
 * @module components/OnboardingTour
 * @description ONB-001 (audit) — "First Run" wizard. Replaces the legacy
 * spotlight-tooltip tour. The old tour was passive (showed users where
 * elements were but never helped them complete a first valuable action);
 * the audit named it as the #1 onboarding gap:
 *
 *   > A new user who completes the tour still has an empty workspace and
 *   > no clear next step. […] Replace the passive tooltip tour with an
 *   > active "First Run" wizard. The wizard creates a real project and
 *   > real tests as its deliverable, making the value concrete.
 *
 * Each step performs a real action against the backend:
 *   1. Welcome   → introduces the 5-step flow
 *   2. Provider  → POST /settings saves Anthropic / OpenAI / Google API key
 *   3. Project   → POST /projects creates a real project from the entered URL
 *   4. Crawl     → POST /projects/:id/crawl kicks off generation (real runId)
 *   5. Review    → navigates to /review-queue with the generated tests
 *   6. Done      → exits, dashboard reflects the new project
 *
 * The component name (`OnboardingTour`) is preserved so `Layout.jsx`'s
 * mounting code (`<OnboardingTour tour={tour} />`) needs zero changes. The
 * `useOnboarding` hook contract is also preserved — `active`, `step`,
 * `stepIndex`, `next`, `prev`, `skip`, `complete` all behave the same.
 *
 * Renders through `<ModalShell>` so it inherits the A11Y-002 focus trap +
 * Escape-key dismiss + `role="dialog"` semantics already exercised by every
 * other modal in the app — no separate accessibility plumbing.
 *
 * @example
 * <OnboardingTour tour={tour} />
 */

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronRight, ChevronLeft, Check, RefreshCw, Sparkles, AlertCircle, Globe2,
} from "lucide-react";
import ModalShell from "../shared/ModalShell.jsx";
import { api } from "../../api.js";

/* Provider options offered in step 1. Local subset of the Settings page's
 * PROVIDERS constant (kept inline so the wizard doesn't import from
 * Settings — Settings is lazy-loaded and importing back here would defeat
 * code-splitting). `id` matches what `api.saveApiKey(id, key)` expects. */
const PROVIDER_OPTIONS = [
  { id: "anthropic", label: "Anthropic Claude", placeholder: "sk-ant-…", hint: "Claude Sonnet 4 — best for code generation." },
  { id: "openai",    label: "OpenAI",           placeholder: "sk-…",     hint: "GPT-4o or GPT-4o-mini." },
  { id: "google",    label: "Google Gemini",    placeholder: "AIza…",    hint: "Gemini 2.5 Flash — fast and cheap." },
  { id: "local",     label: "Ollama (local)",   placeholder: "",         hint: "Free, offline. Requires Ollama running locally." },
];

/**
 * @param {Object} props
 * @param {Object} props.tour - Return value of useOnboarding() hook.
 */
export default function OnboardingTour({ tour }) {
  const navigate = useNavigate();
  const { active, step, stepIndex, totalSteps, next, prev, skip, complete } = tour;

  // ── Wizard state ────────────────────────────────────────────────────────
  // Each step that performs a real backend action keeps its own form state.
  // We don't reset on step change — backing up to "Step 1" after saving a
  // provider shouldn't lose the key the user just typed; the next click on
  // "Save & continue" no-ops gracefully via the saved flag.

  // Step 1 (provider)
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [ollamaModel, setOllamaModel] = useState("llama3.1:8b");

  // Step 2 (project)
  const [projectName, setProjectName] = useState("");
  const [projectUrl, setProjectUrl] = useState("");
  const [createdProjectId, setCreatedProjectId] = useState(null);

  // Step 3 (crawl)
  const [crawlRunId, setCrawlRunId] = useState(null);
  const [crawlStatus, setCrawlStatus] = useState(null); // "running" | "completed" | "failed"

  // Shared
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Reset error whenever the step changes so a previous failure doesn't
  // bleed into the next step's UI.
  useEffect(() => { setError(""); }, [stepIndex]);

  // ── Step actions ────────────────────────────────────────────────────────
  const handleSaveProvider = useCallback(async () => {
    setBusy(true); setError("");
    try {
      if (provider === "local") {
        await api.saveApiKey("local", null, { model: ollamaModel });
      } else {
        if (!apiKey.trim()) { setError("Paste your API key to continue."); setBusy(false); return; }
        await api.saveApiKey(provider, apiKey.trim());
      }
      next();
    } catch (e) {
      setError(e?.message || "Couldn't save the provider. Check the key and try again.");
    } finally {
      setBusy(false);
    }
  }, [provider, apiKey, ollamaModel, next]);

  const handleCreateProject = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const trimmedName = projectName.trim() || "My first project";
      const trimmedUrl = projectUrl.trim();
      if (!trimmedUrl) { setError("Enter the URL of the app you want to test."); setBusy(false); return; }
      // Light client-side URL guard — backend re-validates.
      if (!/^https?:\/\//i.test(trimmedUrl)) { setError("URL must start with http:// or https://"); setBusy(false); return; }
      const project = await api.createProject({ name: trimmedName, url: trimmedUrl });
      setCreatedProjectId(project.id);
      next();
    } catch (e) {
      setError(e?.message || "Couldn't create the project. Check the URL and try again.");
    } finally {
      setBusy(false);
    }
  }, [projectName, projectUrl, next]);

  const handleStartCrawl = useCallback(async () => {
    if (!createdProjectId) { setError("Project missing — go back one step."); return; }
    setBusy(true); setError("");
    try {
      const { runId } = await api.crawl(createdProjectId);
      setCrawlRunId(runId);
      setCrawlStatus("running");
      // We don't block on completion — the user can click "I'll review later"
      // to advance to step 4 (Review Queue) while the run keeps going in the
      // background. The matching `crawl-complete` emitTourEvent will auto-
      // advance for users who stay on this step until generation finishes.
    } catch (e) {
      setError(e?.message || "Couldn't start the crawl. Check that the URL is reachable.");
      setCrawlStatus("failed");
    } finally {
      setBusy(false);
    }
  }, [createdProjectId]);

  // ── Keyboard: Esc to skip, Enter on the welcome / done steps for quick
  // dismissal. Other steps capture Enter inside their forms so global
  // Enter doesn't double-fire.
  useEffect(() => {
    if (!active) return;
    function handleKey(e) {
      if (e.key === "Escape") { skip(); return; }
      if (e.key === "ArrowLeft" && stepIndex > 0 && !busy) { e.preventDefault(); prev(); return; }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active, prev, skip, stepIndex, busy]);

  if (!active || !step) return null;

  const isLastStep = stepIndex === totalSteps - 1;
  const progressPct = ((stepIndex + 1) / totalSteps) * 100;
  const selectedProvider = PROVIDER_OPTIONS.find((p) => p.id === provider);

  // Footer state — the primary CTA varies by step. Action-shaped steps
  // (provider / project / crawl) wire it to their backend handler; intro
  // and outro steps fall through to `next()` / `complete()`.
  let primaryAction = next;
  let primaryLabel = "Continue";
  let primaryDisabled = busy;
  if (step.id === "welcome") {
    primaryLabel = "Get started";
  } else if (step.id === "provider") {
    primaryAction = handleSaveProvider;
    primaryLabel = busy ? "Saving…" : "Save & continue";
    primaryDisabled = busy || (provider !== "local" && !apiKey.trim());
  } else if (step.id === "project") {
    primaryAction = handleCreateProject;
    primaryLabel = busy ? "Creating…" : "Create project";
    primaryDisabled = busy || !projectUrl.trim();
  } else if (step.id === "crawl") {
    if (!crawlRunId) {
      primaryAction = handleStartCrawl;
      primaryLabel = busy ? "Starting…" : "Start crawl";
    } else {
      // Crawl kicked off — let the user advance manually to step 4 (Review
      // Queue) while generation continues in the background. The wizard's
      // `crawl-complete` advanceOn auto-advances for users who wait.
      primaryAction = next;
      primaryLabel = "Open Review Queue →";
    }
  } else if (step.id === "review") {
    primaryAction = () => { navigate(createdProjectId ? `/review-queue?projectId=${createdProjectId}` : "/review-queue"); next(); };
    primaryLabel = "Open Review Queue";
  } else if (step.id === "done") {
    primaryAction = () => { complete(); navigate("/dashboard"); };
    primaryLabel = "Finish";
  }

  return (
    <ModalShell onClose={skip} width="min(560px, 95vw)" ariaLabelledBy="wiz-title" style={{ padding: 0 }}>
      <div className="wiz">
        <div className="wiz__progress" style={{ width: `${progressPct}%` }} />
        <header className="wiz__header">
          <div className="wiz__icon"><Sparkles size={18} /></div>
          <div className="wiz__heading">
            <h2 id="wiz-title" className="wiz__title">{step.title}</h2>
            <div className="wiz__step-label">Step {stepIndex + 1} of {totalSteps}</div>
          </div>
        </header>

        <div className="wiz__body">
          <p className="wiz__desc">{step.description}</p>

          {step.id === "welcome" && (
            <ul className="wiz__checklist">
              <li><Check size={13} /> Save an AI provider</li>
              <li><Check size={13} /> Create your first project</li>
              <li><Check size={13} /> Crawl + auto-generate tests</li>
              <li><Check size={13} /> Review and approve</li>
            </ul>
          )}

          {step.id === "provider" && (
            <div className="wiz__provider-block">
              <div className="wiz__provider-grid">
                {PROVIDER_OPTIONS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`wiz__provider-card${provider === p.id ? " wiz__provider-card--active" : ""}`}
                    onClick={() => setProvider(p.id)}
                    disabled={busy}
                  >
                    <span className="wiz__provider-card-label">{p.label}</span>
                    <span className="wiz__provider-card-hint">{p.hint}</span>
                  </button>
                ))}
              </div>
              {provider === "local" ? (
                <label className="wiz__field">
                  <span className="wiz__field-label">Ollama model</span>
                  <input className="input" type="text" value={ollamaModel} disabled={busy}
                    onChange={(e) => setOllamaModel(e.target.value)} placeholder="llama3.1:8b" />
                </label>
              ) : (
                <label className="wiz__field">
                  <span className="wiz__field-label">API key</span>
                  <input className="input" type="password" autoComplete="off"
                    value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                    placeholder={selectedProvider?.placeholder || "API key"} disabled={busy}
                    onKeyDown={(e) => { if (e.key === "Enter" && !primaryDisabled) handleSaveProvider(); }} />
                </label>
              )}
            </div>
          )}

          {step.id === "project" && (
            <div className="wiz__project-block">
              <label className="wiz__field">
                <span className="wiz__field-label">Project name</span>
                <input className="input" type="text" value={projectName} disabled={busy}
                  onChange={(e) => setProjectName(e.target.value)} placeholder="My first project" />
              </label>
              <label className="wiz__field">
                <span className="wiz__field-label">App URL</span>
                <input className="input" type="url" value={projectUrl} disabled={busy}
                  onChange={(e) => setProjectUrl(e.target.value)} placeholder="https://example.com"
                  onKeyDown={(e) => { if (e.key === "Enter" && !primaryDisabled) handleCreateProject(); }} />
                <span className="wiz__field-hint">
                  <Globe2 size={11} /> Use a staging or test-friendly site — production CAPTCHA / WAFs block automation.
                </span>
              </label>
            </div>
          )}

          {step.id === "crawl" && (
            <div className="wiz__crawl">
              {!crawlRunId && (
                <p className="wiz__field-hint">We'll crawl your site and generate tests. Usually 1–3 minutes — you can continue without waiting.</p>
              )}
              {crawlRunId && crawlStatus === "running" && (
                <div className="wiz__crawl-running">
                  <RefreshCw size={14} className="spin" />
                  <span>Crawling and generating tests. You can continue — generation keeps running in the background.</span>
                </div>
              )}
              {crawlStatus === "failed" && (
                <div className="wiz__error">
                  <AlertCircle size={13} /> Crawl failed. Check the URL or skip and try later from the project page.
                </div>
              )}
            </div>
          )}

          {step.id === "review" && (
            <p className="wiz__field-hint">
              Tests with a quality score above your project's auto-approval threshold (default 75) get approved automatically. Others land in the Review Queue for human review.
            </p>
          )}

          {step.id === "done" && (
            <div className="wiz__done">
              <Check size={16} className="wiz__done-check" />
              <span>You can rerun this wizard any time from Account settings → "Restart Tour".</span>
            </div>
          )}

          {error && (
            <div className="wiz__error">
              <AlertCircle size={13} /> {error}
            </div>
          )}
        </div>

        <footer className="wiz__footer">
          {stepIndex > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={prev} disabled={busy}>
              <ChevronLeft size={13} /> Back
            </button>
          )}
          <div className="wiz__footer-spacer" />
          {!isLastStep && (
            <button className="btn btn-ghost btn-sm" onClick={skip} disabled={busy}>Skip</button>
          )}
          <button className="btn btn-primary btn-sm" onClick={primaryAction} disabled={primaryDisabled}>
            {busy && <RefreshCw size={13} className="spin" />}
            {primaryLabel}
            {!isLastStep && !busy && <ChevronRight size={13} />}
          </button>
        </footer>
      </div>
    </ModalShell>
  );
}
