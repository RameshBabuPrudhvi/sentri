/**
 * @module pages/TestLab
 * @description Dedicated workspace for AI test generation — crawl-based and
 * requirement-based flows live here instead of inside project-detail modals.
 * Provides a three-pane layout: project selector | configuration | launch panel.
 *
 * State machine:
 *   idle      → configure options, hit Start
 *   running   → pipeline steps + live log + real-time stats via SSE
 *   done      → summary stats + link to run detail
 *
 * Tab routing: "crawl" | "requirement" | "queue"
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Link2, Zap, Play, StopCircle, CheckCircle2, Clock,
  ArrowRight, ChevronRight, RotateCcw, Atom, Video,
  Upload, Paperclip, Trash2, Copy, Check, RefreshCw,
} from "lucide-react";
import { api } from "../api.js";
import { useRunSSE } from "../hooks/useRunSSE.js";
import useProjectData, { invalidateProjectDataCache } from "../hooks/useProjectData.js";
import usePageTitle from "../hooks/usePageTitle.js";
import { fmtRelativeDate } from "../utils/formatters.js";
import SiteGraph from "../components/crawl/SiteGraph.jsx";
import RecorderModal from "../components/run/RecorderModal.jsx";
import TestConfig from "../components/test/TestConfig.jsx";
import { loadSavedConfig } from "../utils/testDialsStorage.js";


// ── Constants ─────────────────────────────────────────────────────────────────

const PIPELINE_STAGES = [
  { label: "Crawl & snapshot",     step: 1, key: "pagesFound",          unit: "pages" },
  { label: "Filter elements",      step: 2, key: "elementsKept",         unit: "kept"  },
  { label: "Classify intents",     step: 3, key: "journeysDetected",     unit: "flows" },
  { label: "Generate tests",       step: 4, key: "rawTestsGenerated",    unit: "raw"   },
  { label: "Deduplicate",          step: 5, key: "duplicatesRemoved",    unit: "removed" },
  { label: "Enhance assertions",   step: 6, key: "assertionsEnhanced",   unit: "enhanced" },
  { label: "Validate",             step: 7, key: "validationRejected",   unit: "rejected" },
  { label: "Done",                 step: 8, key: null,                   unit: null },
];

// Coverage / perspective / quality / test-count / profile option lists used to
// live here; they have moved to the shared <TestConfig /> component which
// composes them from `frontend/src/config/testDialsConfig.js` (the same
// canonical source the legacy CrawlProjectModal / GenerateTestModal used).

const REQ_EXAMPLES = [
  "User login with valid credentials",
  "Add to cart and checkout",
  "Form validation blocks invalid input",
  "Password reset flow end-to-end",
];

// ── Attachment limits ────────────────────────────────────────────────────────
// Mirror the legacy GenerateTestModal contract (40 KB per file, 45 KB total —
// backend caps `description` at 50 KB so we leave headroom for the prompt
// scaffold). Same MIME-allowlist + binary-detection guards prevent users from
// pasting screenshots / PDFs that would blow up token counts.
const ACCEPTED_EXTENSIONS = ".txt,.md,.csv,.json,.xml,.html,.yml,.yaml,.feature,.gherkin";
const MAX_ATTACHMENT_SIZE  = 40_000;
const MAX_TOTAL_ATTACHMENT = 45_000;
const TEXT_MIME_PREFIXES   = ["text/", "application/json", "application/xml", "application/x-yaml", "application/yaml"];
const TEXT_MIME_EXACT      = new Set([
  "text/plain", "text/csv", "text/html", "text/markdown", "text/xml", "text/yaml",
  "application/json", "application/xml", "application/x-yaml", "application/yaml",
]);

function isTextMime(file) {
  const mime = (file.type || "").toLowerCase();
  // No MIME (e.g. .feature, .gherkin) — allow because the OS picker already
  // filtered by the ACCEPTED_EXTENSIONS list.
  if (!mime) return true;
  if (TEXT_MIME_EXACT.has(mime)) return true;
  return TEXT_MIME_PREFIXES.some(p => mime.startsWith(p));
}

// ── Persistence ──────────────────────────────────────────────────────────────
//
// The pipeline + log views are driven by component-local state (`activeRun`,
// `runData`, `logLines`). Without persistence, navigating away from Test Lab
// unmounts the component and wipes the state, so returning mid-run shows an
// empty idle panel instead of the in-flight pipeline. We mirror the live run
// to sessionStorage so soft navigation within the app is seamless; on mount
// we rehydrate and the SSE hook auto-reconnects (its `snapshot` event refills
// pipeline counters, and new log lines resume streaming from the reconnect
// point). sessionStorage is scoped per-tab, which matches the UX we want.

const STORAGE_KEY = "sentri.testLab.activeRun";
const LOG_CAP     = 200; // bound storage size — the LiveLog UI slices at -40

// Test Lab's Queue + Active Runs panels only describe AI generation runs —
// the pipeline visualisation, "Step N/8" subtitle, and the attach-to-live
// view all assume the 8-stage crawl/generate pipeline. Regression `test_run`
// and recorder `record` runs use a different step model and would render
// as "Step ?/8" with a nonsensical "Crawl & Generate" / "Requirement" label,
// so we exclude them. Mirrors `backend/src/routes/dashboard.js:200`.
// Module-scoped so React's dependency analysis doesn't see a new function
// reference every render.
const isGenerationRun = (r) => r.type === "crawl" || r.type === "generate";

function loadPersistedRun() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.activeRun?.runId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistRun(activeRun, runData, logLines) {
  try {
    if (!activeRun?.runId) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      activeRun,
      runData,
      logLines: logLines.slice(-LOG_CAP),
    }));
  } catch { /* quota / private mode — non-fatal */ }
}

function clearPersistedRun() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* non-fatal */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive stage state for a pipeline step given the run's currentStep. */
function stageStatus(step, currentStep, status) {
  if (status === "completed" || status === "completed_empty") {
    return "done";
  }
  // For failed/aborted runs, freeze the pipeline at the step where it died
  // rather than leaving it pulsing as if still running. The step the run
  // stopped on is marked "done" (we reached it) but no step is "active".
  if (status === "failed" || status === "aborted") {
    if (currentStep == null) return "pending";
    if (step <= currentStep) return "done";
    return "pending";
  }
  if (currentStep == null) return "pending";
  if (step < currentStep) return "done";
  if (step === currentStep) return "active";
  return "pending";
}

/** Build a project avatar colour from its initial letter (deterministic). */
function avatarStyle(initial) {
  const hues = {
    A: 210, B: 280, C: 340, D: 170, E: 50, F: 120, G: 15,
    H: 255, I: 190, J: 320, K: 90, L: 200, M: 30, N: 160,
    O: 60, P: 295, Q: 135, R: 0, S: 240, T: 75, U: 215,
    V: 145, W: 350, X: 180, Y: 45, Z: 270,
  };
  const h = hues[(initial || "?").toUpperCase()] ?? 200;
  return {
    background: `hsl(${h},60%,90%)`,
    color: `hsl(${h},60%,30%)`,
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────
// `ChipGroup` was inlined here for the Crawl/Requirement chip rows; chip
// rendering now lives in `frontend/src/components/test/TestConfig.jsx` and is
// shared with the rest of the app.

/**
 * Compact project avatar with deterministic colour from the project name initial.
 *
 * @param {{ project: Object }} props
 */
function ProjIcon({ project }) {
  const initial = (project?.name || "?")[0].toUpperCase();
  return (
    <div className="tl-proj-icon" style={avatarStyle(initial)}>
      {initial}
    </div>
  );
}

/**
 * Pipeline stage list shown while a crawl run is active.
 *
 * @param {{ run: Object }} props
 */
function PipelinePanel({ run }) {
  const cs = run?.currentStep ?? null;
  const ps = run?.pipelineStats || {};
  const status = run?.status ?? "running";

  return (
    <div className="tl-pipeline">
      {PIPELINE_STAGES.map(stage => {
        const state = stageStatus(stage.step, cs, status);
        const statVal = stage.key ? ps[stage.key] : null;
        return (
          <div key={stage.step} className={`tl-stage tl-stage--${state}`}>
            <div className={`tl-stage-dot tl-stage-dot--${state}`} />
            <span className="tl-stage-name">{stage.label}</span>
            {statVal != null && (
              <span className="tl-stage-stat">
                {statVal} {stage.unit}
              </span>
            )}
            {state === "active" && statVal == null && (
              <span className="tl-stage-stat" style={{ color: "var(--accent)" }}>running…</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Live log terminal — scrolls to bottom on each new entry.
 *
 * @param {{ lines: string[] }} props
 */
function LiveLog({ lines }) {
  const endRef = useRef(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  // Copy the *full* buffer (not just the visible -40 slice) so the user can
  // share the complete log when triaging an issue. `navigator.clipboard`
  // requires HTTPS or localhost; the catch keeps the button silent on
  // unsupported origins instead of throwing into the console.
  function handleCopy() {
    const text = lines.join("\n");
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => { /* clipboard unavailable — non-fatal */ });
  }

  return (
    <div className="tl-live-log">
      {/* Icon-only copy button pinned to the top-right of the log surface.
          `tl-log-copy` is absolutely positioned against the non-scrolling
          `.tl-live-log` wrapper so it stays in view as the user scrolls
          through `.tl-live-log-scroll` below. Disabled when the buffer is
          empty so users can't no-op-copy a blank log. */}
      <button
        type="button"
        className={`tl-log-copy${copied ? " tl-log-copy--copied" : ""}`}
        onClick={handleCopy}
        disabled={lines.length === 0}
        title={copied ? "Copied to clipboard" : "Copy log to clipboard"}
        aria-label="Copy log to clipboard"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {/* Inner scroll surface — the absolutely-positioned copy button above
          stayed visually pinned only when the scroll happened on a separate
          element. Co-locating `overflow-y: auto` on the parent caused the
          button to scroll *with* the log content (absolute children of a
          scroll container participate in its scroll). */}
      <div className="tl-live-log-scroll">
        {lines.slice(-40).map((line, i) => {
          // Backend emits lines as `[ISO timestamp] <emoji> <message>` (see
          // `backend/src/utils/runLogger.js` and `backend/src/crawler.js`), so
          // we can't anchor the classifier at index 0 — the leading bracketed
          // timestamp pushes the emoji past the start. Scan for the first
          // recognisable marker anywhere in the line; first match wins.
          let cls = "tl-log-dim";
          if (/[✅✓]/.test(line) || /\bPASSED\b/.test(line))           cls = "tl-log-ok";
          else if (/[❌✗]/.test(line) || /\b(FAILED|ERROR)\b/i.test(line)) cls = "tl-log-error";
          else if (/[⚠️]/.test(line) || /\bWARN(ING)?\b/i.test(line))     cls = "tl-log-warn";
          else if (/[🏁🚀🕷️🔍🤖→▶]/.test(line))                          cls = "tl-log-info";
          return <div key={i} className={cls}>{line}</div>;
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/**
 * Single queue row for the Queue tab.
 *
 * @param {{ run: Object, project: Object, onStop: Function, onAttach: Function }} props
 *   `onAttach` is called for active runs to reattach the live view; it falls
 *   back to navigating to `/runs/:id` for completed runs.
 */
function QueueRow({ run, project, onStop, onAttach }) {
  const navigate = useNavigate();
  const isActive    = run.status === "running";
  const isCompleted = run.status === "completed" || run.status === "completed_empty";
  const isFailed    = run.status === "failed";
  const isAborted   = run.status === "aborted";
  // Any terminal status dims the row + suppresses the progress bar.
  const isTerminal  = isCompleted || isFailed || isAborted;

  const pct = run.currentStep != null
    ? Math.round(((run.currentStep - 1) / 7) * 100)
    : 0;

  // Subtitle reflects the actual outcome — a failed run must not read as
  // "Completed · N tests generated", and an aborted run must not fall through
  // to the "Queued" branch.
  let subtitle;
  if (isActive && run.currentStep != null) {
    subtitle = `Step ${run.currentStep}/8 · ${PIPELINE_STAGES[run.currentStep - 1]?.label ?? ""} · started ${fmtRelativeDate(run.startedAt)}`;
  } else if (isCompleted) {
    subtitle = `Completed · ${run.testsGenerated ?? 0} tests generated · ${fmtRelativeDate(run.startedAt)}`;
  } else if (isFailed) {
    subtitle = `Failed${run.error ? ` — ${run.error}` : ""} · ${fmtRelativeDate(run.startedAt)}`;
  } else if (isAborted) {
    subtitle = `Aborted · ${fmtRelativeDate(run.startedAt)}`;
  } else {
    subtitle = `Queued · ${fmtRelativeDate(run.startedAt)}`;
  }

  return (
    <div className={`tl-queue-row${isTerminal ? " tl-queue-row--done" : ""}`}>
      <ProjIcon project={project} />
      <div className="tl-queue-info">
        <div className="tl-queue-name">
          {project?.name ?? "Unknown"} · {run.type === "crawl" ? "Crawl & Generate" : "Requirement"}
        </div>
        <div className="tl-queue-sub">{subtitle}</div>
      </div>

      {isActive && (
        <div className="tl-queue-progress">
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {isCompleted && (
        <span className="badge badge-green" style={{ flexShrink: 0 }}>done</span>
      )}
      {isFailed && (
        <span className="badge badge-red" style={{ flexShrink: 0 }}>failed</span>
      )}
      {isAborted && (
        <span className="badge badge-amber" style={{ flexShrink: 0 }}>aborted</span>
      )}

      {isActive ? (
        <>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onAttach?.(run)}
            title="Attach the live pipeline view to this run"
            style={{ flexShrink: 0 }}
          >
            View <ArrowRight size={13} />
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onStop(run.id)}
            style={{ flexShrink: 0 }}
          >
            <StopCircle size={14} />
            Stop
          </button>
        </>
      ) : (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => navigate(`/runs/${run.id}`)}
          style={{ flexShrink: 0 }}
        >
          View <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TestLab() {
  usePageTitle("Test Lab");
  const navigate = useNavigate();
  const { id: routeProjectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Data ──
  // Shared TanStack Query hook — participates in the app-wide project/run cache
  // (30 s staleTime) so mutations elsewhere (e.g. Tests page approve/reject,
  // Projects create/delete) refresh Test Lab automatically via
  // `invalidateProjectDataCache()`.
  // We need `allTests` so the launch panel's "Existing tests" stat reflects the
  // real test inventory for the selected project, not a cumulative
  // testsGenerated sum across historical runs.
  const { projects, allRuns, allTests, loading: loadingProjectData } = useProjectData();
  const loadingProjects = loadingProjectData;
  const [selectedId, setSelectedId]       = useState(routeProjectId ?? null);

  // ── Config state ──
  // Single source of truth for the full Test Dials surface. Seeded from
  // localStorage via `loadSavedConfig()` so user preferences survive page
  // reloads — matches the legacy CrawlProjectModal / GenerateTestModal
  // behaviour and feeds the unified <TestConfig /> component below.
  const [tab, setTab]                     = useState(searchParams.get("tab") || "crawl");
  const [dialsConfig, setDialsConfig]     = useState(() => loadSavedConfig());
  const [requirement, setRequirement]     = useState("");
  // Optional override — if blank we derive from the requirement's first line
  // at submit time (matches GenerateTestModal's old behaviour, just gives the
  // user a chance to fix a noisy auto-derived name).
  const [testName, setTestName]           = useState("");
  // Plain-text attachments folded into the AI prompt's `description`. Mirrors
  // GenerateTestModal — same 40 KB / 45 KB caps, same MIME allowlist.
  const [attachments, setAttachments]     = useState([]); // [{ name, content }]
  const [showImportIssue, setShowImportIssue] = useState(false);
  const [importIssueText, setImportIssueText] = useState("");
  const fileInputRef    = useRef(null);
  const requirementRef  = useRef(null);

  // ── Run state ──
  // Rehydrate from sessionStorage so navigating away and back resumes the live
  // pipeline view without a gap. The SSE hook will auto-reconnect using the
  // persisted `runId` and its first `snapshot` event will refresh pipeline
  // counters from the server's authoritative copy.
  const persisted = useMemo(() => loadPersistedRun(), []);
  const [activeRun, setActiveRun]   = useState(persisted?.activeRun ?? null);
  const [runData, setRunData]       = useState(persisted?.runData ?? null);
  const [logLines, setLogLines]     = useState(persisted?.logLines ?? []);
  const [launching, setLaunching]   = useState(false);
  const [innerTab, setInnerTab]     = useState("pipeline");
  const [stopLoading, setStopLoading] = useState(false);
  const [error, setError]           = useState(null);

  // ── Queue state ──
  const [queueFilter, setQueueFilter]   = useState("all");

  // ── Recorder state ──
  // Recording stays as a modal (not a tab) because it's inherently
  // overlay-oriented — the live screencast preview needs a focused surface.
  // The Test Lab page just provides a launch point so users don't have to
  // bounce back to the Tests page to start a recording session.
  const [showRecorder, setShowRecorder] = useState(false);

  // ── Seed selected project from route / project list ──
  // `useProjectData` owns the actual fetch; this effect just syncs the
  // currently-selected project id to whatever the route / loaded project list
  // implies, without re-triggering any network calls.
  useEffect(() => {
    if (!projects.length) return;
    const routeMatch = routeProjectId && projects.some(p => p.id === routeProjectId)
      ? routeProjectId
      : null;
    // If a run was rehydrated from sessionStorage on the non-project-scoped
    // `/test-lab` route, prefer its project over `projects[0]` so the header
    // label and any subsequent launch target the correct project.
    const activeMatch = activeRun?.projectId && projects.some(p => p.id === activeRun.projectId)
      ? activeRun.projectId
      : null;
    setSelectedId(prev => {
      // Validate `prev` against the loaded project list — a stale bookmark
      // (e.g. `/projects/DELETED-ID/test-lab`) seeds `prev` with a non-null
      // ID that doesn't exist, and without this check the `??` chain would
      // stop there and never fall through to `activeMatch` / `projects[0]`,
      // leaving the UI with no selected project and the Start button
      // permanently disabled.
      const prevValid = prev && projects.some(p => p.id === prev) ? prev : null;
      return routeMatch ?? prevValid ?? activeMatch ?? projects[0].id;
    });
  }, [routeProjectId, projects, activeRun?.projectId]);

  // ── Derive runs grouped by project (replaces the old `projectRuns` state) ──
  const projectRuns = useMemo(() => {
    const byProj = {};
    for (const r of allRuns) {
      if (!byProj[r.projectId]) byProj[r.projectId] = [];
      byProj[r.projectId].push(r);
    }
    return byProj;
  }, [allRuns]);

  // ── Sync tab to URL param ──
  // Use a functional updater so we preserve any other search params that may
  // have been set by external navigation or future features — naively passing
  // `{}` / `{ tab }` would strip everything else on every tab change.
  useEffect(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === "crawl") next.delete("tab");
      else next.set("tab", tab);
      return next;
    }, { replace: true });
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Autofocus the requirement textarea on tab switch ──
  // Mirrors GenerateTestModal's `nameRef.current?.focus()` on mount — when the
  // user switches into the Requirement tab we put the cursor in the textarea
  // so they can start typing immediately.
  useEffect(() => {
    if (tab !== "requirement") return;
    if (activeRun) return;          // skip when the run view is mounted
    const t = setTimeout(() => requirementRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [tab, activeRun]);

  // ── Attachment helpers ──
  // Read user-supplied text files into memory so we can fold them into the
  // requirement when launching. Each file is MIME-checked and binary-scanned
  // (>5% non-printable bytes in the first 1 KB → reject) before being added,
  // and we strip common prompt-injection markers (matches the backend
  // `testDials.js` sanitisation).
  function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // allow re-selecting the same file after removal
    for (const file of files) {
      if (!isTextMime(file)) {
        setError(`"${file.name}" appears to be a binary file (${file.type || "unknown type"}). Only text-based files are supported.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_SIZE) {
        setError(`"${file.name}" is too large (${Math.round(file.size / 1000)} KB). Max is 40 KB per file.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const raw = reader.result;
        const sample = raw.slice(0, 1024);
        const nonPrintable = [...sample].filter(c => {
          const code = c.charCodeAt(0);
          return code < 32 && code !== 9 && code !== 10 && code !== 13;
        }).length;
        if (sample.length > 0 && nonPrintable / sample.length > 0.05) {
          setError(`"${file.name}" contains binary data and cannot be used as a text attachment.`);
          return;
        }
        const content = raw
          .replace(/^(SYSTEM|ASSISTANT|USER|HUMAN|AI)\s*:/gim, "")
          .replace(/```/g, "");
        setAttachments(prev => {
          if (prev.some(a => a.name === file.name)) return prev;
          const totalSize = prev.reduce((n, a) => n + a.content.length, 0) + content.length;
          if (totalSize > MAX_TOTAL_ATTACHMENT) {
            setError("Total attachment size would exceed 45 KB. Remove an existing file first.");
            return prev;
          }
          return [...prev, { name: file.name, content }];
        });
      };
      reader.onerror = () => setError(`Failed to read "${file.name}".`);
      reader.readAsText(file);
    }
  }

  function removeAttachment(fileName) {
    setAttachments(prev => prev.filter(a => a.name !== fileName));
  }

  // Parse pasted Jira issue text into name + description. Accepts:
  //   "PROJ-123 Login fails for SSO users\nAs a user…"
  //   "Login fails for SSO users\nAs a user…"
  function handleImportIssue() {
    const raw = importIssueText.trim();
    if (!raw) return;
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || "";
    const parsedName = firstLine.replace(/^[A-Z][A-Z0-9]+-\d+\s*[-:.]?\s*/, "").trim();
    const parsedDesc = lines.slice(1).join("\n").trim();
    if (parsedName) setTestName(parsedName);
    if (parsedDesc) setRequirement(prev => prev ? `${prev}\n\n${parsedDesc}` : parsedDesc);
    setImportIssueText("");
    setShowImportIssue(false);
    if (error) setError(null);
  }

  // ── SSE handler for active run ──
  const handleSSEEvent = useCallback((event) => {
    if (event.type === "snapshot" && event.run) {
      setRunData(prev => ({ ...prev, ...event.run }));
    }
    if (event.type === "run_update" || event.type === "update") {
      setRunData(prev => ({ ...prev, ...event.run }));
    }
    if (event.type === "log" && event.message) {
      // Cap in-memory log buffer to bound memory + avoid O(n²) re-allocation
      // on long runs. `LiveLog` only renders the last 40 lines anyway, and
      // `persistRun` already caps its sessionStorage copy at LOG_CAP.
      setLogLines(prev => {
        const next = [...prev, event.message];
        return next.length > LOG_CAP ? next.slice(-LOG_CAP) : next;
      });
    }
    // The hook fires its own `type: "done"` event when SSE closes, with
    // `status` at the top level (not under `event.run`). Handle both shapes.
    const terminalStatus =
      event.type === "done" ? (event.status ?? event.run?.status ?? "completed")
      : (event.run?.status === "completed" || event.run?.status === "completed_empty"
         || event.run?.status === "failed"  || event.run?.status === "aborted")
        ? event.run.status
        : null;
    if (terminalStatus) {
      setRunData(prev => ({ ...prev, ...(event.run || {}), status: terminalStatus }));
      // Bust the shared cache so the Queue tab and Active-Runs panel pick up
      // the final test count / failure state without waiting for staleTime.
      invalidateProjectDataCache();
    }
  }, []);

  // Drive the SSE connection with the live run status so the hook auto-closes
  // when the run finishes (`done` event) and *stays* closed on subsequent
  // re-renders. Passing a static "running" string would cause the hook to keep
  // reconnecting after completion — see useRunSSE's `alreadyDone` guard.
  const sseInitialStatus = activeRun
    ? (runData?.status === "running" || runData?.status == null ? "running" : runData.status)
    : undefined;
  // Capture `sseDown` / `retryIn` so we can surface SSE drops to the user —
  // mirrors RunDetail.jsx's reconnect / polling-fallback banners. Without
  // this, an SSE outage mid-run would silently stall the pipeline view with
  // no indication that updates have stopped.
  const { sseDown, retryIn } = useRunSSE(activeRun?.runId ?? null, handleSSEEvent, sseInitialStatus);

  // ── Persist the active run to sessionStorage on every change ──
  // Clearing activeRun (via handleReset / Dismiss) also clears storage so the
  // next mount starts fresh. A terminal status is kept in storage briefly so a
  // navigation round-trip still lands on the done/failed banner rather than
  // the idle config panel.
  useEffect(() => {
    persistRun(activeRun, runData, logLines);
  }, [activeRun, runData, logLines]);

  // ── Derived ──
  const selectedProject = projects.find(p => p.id === selectedId) ?? null;
  const lastCrawlRun = useMemo(() => {
    const runs = projectRuns[selectedId] || [];
    return runs.find(r => r.type === "crawl") ?? null;
  }, [projectRuns, selectedId]);

  // `allRuns` from useProjectData is already sorted newest-first.
  // `isGenerationRun` is module-scoped (see above) to keep the `useMemo`
  // dependency arrays honest — a fresh closure every render would otherwise
  // invalidate the memo on every render.
  const activeQueueRuns = useMemo(
    () => allRuns.filter(r => isGenerationRun(r) && r.status === "running"),
    [allRuns],
  );
  const recentQueueRuns = useMemo(
    () => allRuns.filter(r => isGenerationRun(r) && r.status !== "running").slice(0, 8),
    [allRuns],
  );

  // ── Actions ──
  // The unified <TestConfig /> component owns the full dialsConfig shape that
  // the backend's `resolveDialsConfig()` already validates (approach,
  // perspectives[], quality[], format, testCount, exploreMode + tuning,
  // options, language, customInstructions, parallelWorkers). We pass the
  // object straight through — no per-field re-packing — so adding a new dial
  // upstream automatically reaches the backend.

  /**
   * Confirm the backend has at least one usable AI provider before we kick off
   * a long-running pipeline. Mirrors the legacy CrawlProjectModal /
   * GenerateTestModal pre-flight — without it the user gets a generic 4xx
   * several seconds in instead of an actionable "go to Settings" message.
   * Failures here are non-fatal: if `/config` itself errors we fall through
   * and let the actual API call surface the real problem.
   */
  async function ensureAiProvider() {
    try {
      const config = await api.getConfig();
      if (config && config.hasProvider === false) {
        setError("No AI provider configured — open Settings to add an API key or enable Ollama.");
        return false;
      }
    } catch { /* non-fatal — proceed and surface the real error from the run call */ }
    return true;
  }

  async function handleStartCrawl() {
    if (!selectedId) return;
    setError(null);
    if (!(await ensureAiProvider())) return;
    setLaunching(true);
    // Detach from any previous run BEFORE clearing runData. Otherwise the SSE
    // hook would re-evaluate `sseInitialStatus` as "running" (activeRun still
    // set + runData null) and reconnect to the old completed run during the
    // await window, poisoning runData with stale terminal state and blocking
    // SSE for the new run (`alreadyDone` guard in useRunSSE).
    setActiveRun(null);
    setLogLines([]);
    setRunData(null);
    clearPersistedRun();
    try {
      const { runId } = await api.crawl(selectedId, { dialsConfig });
      setActiveRun({ runId, projectId: selectedId, type: "crawl" });
      setInnerTab("pipeline");
    } catch (err) {
      setError(err.message || "Failed to start crawl.");
    } finally {
      setLaunching(false);
    }
  }

  async function handleGenerateFromRequirement() {
    if (!selectedId || !requirement.trim()) return;
    setError(null);
    if (!(await ensureAiProvider())) return;
    setLaunching(true);
    // See handleStartCrawl — detach from any previous run before clearing
    // runData to avoid an SSE reconnect race.
    setActiveRun(null);
    setLogLines([]);
    setRunData(null);
    clearPersistedRun();
    try {
      // Backend requires `name`. Prefer the user-supplied override; otherwise
      // derive from the requirement's first line (trimmed to ~80 chars).
      const reqText = requirement.trim();
      const firstLine = reqText.split("\n")[0].trim();
      const derivedName = firstLine.length > 80
        ? firstLine.slice(0, 77) + "…"
        : firstLine;
      const finalName = testName.trim() || derivedName;
      // Fold attachments into `description` — same shape the legacy modal
      // used, so the backend `userRequestedPrompt` path sees identical input.
      let fullDescription = reqText;
      if (attachments.length > 0) {
        const block = attachments
          .map(a => `--- Attached file: ${a.name} ---\n${a.content}`)
          .join("\n\n");
        fullDescription = fullDescription ? `${fullDescription}\n\n${block}` : block;
      }
      const { runId } = await api.generateTest(selectedId, {
        name: finalName,
        description: fullDescription,
        dialsConfig,
      });
      // Use backend's canonical type name (`"generate"`) so
      // `activeRun.type` matches `run.type` on re-attach and any future
      // strict equality checks don't silently fork.
      setActiveRun({ runId, projectId: selectedId, type: "generate" });
      setInnerTab("pipeline");
    } catch (err) {
      setError(err.message || "Failed to generate tests.");
    } finally {
      setLaunching(false);
    }
  }

  async function handleStop() {
    if (!activeRun?.runId) return;
    setStopLoading(true);
    try {
      await api.abortRun(activeRun.runId);
      // Mark the local copy as aborted so the SSE hook closes (it skips
      // connecting for any non-"running" initialStatus) and the config-panel
      // shows the aborted banner. The eventual SSE `done` event will reconcile
      // with the server's authoritative status.
      setRunData(prev => ({ ...prev, status: "aborted" }));
      invalidateProjectDataCache();
    } catch { /* non-fatal */ } finally {
      setStopLoading(false);
    }
  }

  async function handleQueueStop(runId) {
    try {
      await api.abortRun(runId);
      // Bust the shared project/run cache so the Queue reflects the abort on
      // the next refetch — no ad-hoc local state to keep in sync.
      invalidateProjectDataCache();
    } catch { /* non-fatal */ }
  }

  function handleReset() {
    setActiveRun(null);
    setRunData(null);
    setLogLines([]);
    setError(null);
    // Explicit clear in addition to the write-through effect — avoids a stale
    // read if the user immediately navigates away before the effect flushes.
    clearPersistedRun();
  }

  /**
   * Attach the Test Lab live-view (pipeline + logs) to an existing run that
   * was either started elsewhere or dropped when the user navigated away.
   * Seeds `activeRun` / `runData` from the cached run row so the SSE hook
   * reconnects and the panel lights up immediately.
   *
   * @param {Object} run - Run row from `allRuns` (has `id`, `projectId`, `type`, `status`, …).
   */
  function handleAttachRun(run) {
    if (!run?.id) return;
    // Switch project scope if the run belongs to a different project.
    if (run.projectId && run.projectId !== selectedId) {
      setSelectedId(run.projectId);
      if (routeProjectId) {
        const qs = searchParams.toString();
        navigate(`/projects/${run.projectId}/test-lab${qs ? `?${qs}` : ""}`, { replace: true });
      }
    }
    setActiveRun({ runId: run.id, projectId: run.projectId, type: run.type });
    // Seed runData with whatever we already have cached — SSE's first
    // `snapshot` event will overwrite with the authoritative server copy.
    setRunData({ ...run, status: run.status });
    setLogLines([]);
    setInnerTab("pipeline");
    setError(null);
    // If we were on the Queue tab, switch to the matching config tab so the
    // user sees the pipeline view (which only renders under crawl/requirement).
    if (tab === "queue") {
      setTab(run.type === "crawl" ? "crawl" : "requirement");
    }
  }

  /**
   * Switch the selected project without orphaning an in-flight run.
   *
   * If a run is active in the panel, we ask the user to confirm — switching
   * detaches the SSE panel from that run but leaves it executing on the
   * server (it remains visible in the Queue tab and can be aborted from
   * there). Without this guard the previous behaviour silently abandoned the
   * run and gave the user no way to return to the live view.
   *
   * @param {string} nextProjectId
   */
  function handleSelectProject(nextProjectId) {
    if (nextProjectId === selectedId) return;
    if (isRunActive) {
      const ok = window.confirm(
        "A generation run is in progress for the current project. " +
        "Switching projects will close this live view — the run keeps executing " +
        "and stays visible in the Queue tab. Continue?",
      );
      if (!ok) return;
    }
    setSelectedId(nextProjectId);
    handleReset();
    if (routeProjectId) {
      const qs = searchParams.toString();
      navigate(`/projects/${nextProjectId}/test-lab${qs ? `?${qs}` : ""}`, { replace: true });
    }
  }

  // ── Compute launch panel data ──
  const pagesFound    = lastCrawlRun?.pagesFound ?? selectedProject?.pagesFound ?? null;
  // Count the project's actual current tests (not cumulative testsGenerated
  // across all historical runs — that double-counts dedup'd / rejected /
  // deleted tests and grows monotonically).
  const existingTests = useMemo(() => {
    if (!selectedId) return null;
    return allTests.filter(t => t.projectId === selectedId).length;
  }, [allTests, selectedId]);

  const runStatus   = runData?.status;
  const isRunActive = !!activeRun && (runStatus === "running" || runStatus == null);
  const isRunDone   = runStatus === "completed" || runStatus === "completed_empty";
  const isRunFailed = runStatus === "failed" || runStatus === "aborted";
  const ps          = runData?.pipelineStats || {};

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="tl-wrap">

      {/* ── Tab bar ── */}
      <div className="tl-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 24, paddingRight: 24, borderRight: "1px solid var(--border)" }}>
          <Atom size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontWeight: 700, fontSize: "0.92rem", color: "var(--text)" }}>Test Lab</span>
          <span style={{ fontSize: "0.78rem", color: "var(--text3)", fontWeight: 400 }}>AI test generation workspace</span>
        </div>

        <button
          className={`tl-tab-btn${tab === "crawl" ? " tl-tab-btn--active" : ""}`}
          onClick={() => setTab("crawl")}
        >
          <Link2 size={14} />
          Crawl &amp; Generate
        </button>
        <button
          className={`tl-tab-btn${tab === "requirement" ? " tl-tab-btn--active" : ""}`}
          onClick={() => setTab("requirement")}
        >
          <Zap size={14} />
          Generate from Requirement
        </button>
        <button
          className={`tl-tab-btn${tab === "queue" ? " tl-tab-btn--active" : ""}`}
          onClick={() => setTab("queue")}
        >
          Queue
          {activeQueueRuns.length > 0 && (
            <span className="tl-tab-badge">{activeQueueRuns.length}</span>
          )}
        </button>

        {/* Record action — right-aligned, styled as a primary CTA so it
            reads as a peer to the tabs rather than disappearing as a ghost
            button. Recording remains a modal because the live screencast
            preview needs a focused overlay surface; the Test Lab page only
            provides the launch point. Disabled until a project is selected
            so we have a valid `projectId` to seed. */}
        <button
          className="btn btn-primary btn-sm"
          style={{
            marginLeft: "auto",
            marginRight: 16,
            gap: 6,
            fontWeight: 600,
            background: "var(--red)",
            borderColor: "var(--red)",
            color: "#fff",
          }}
          onClick={() => setShowRecorder(true)}
          disabled={!selectedProject}
          title={selectedProject
            ? `Record a test in ${selectedProject.name}`
            : "Select a project first"}
        >
          <Video size={14} />
          Record a test
        </button>
      </div>

      {/* ── Queue tab ── */}
      {tab === "queue" && (
        <div className="tl-queue-wrap fade-in">
          <div className="tl-queue-header">
            <div>
              <h2 className="page-title" style={{ marginBottom: 2 }}>Queue</h2>
              <p className="page-subtitle">All active and recent generation runs across projects</p>
            </div>
            <div className="flex-between gap-sm" style={{ alignItems: "center" }}>
              <span className="badge badge-blue">{activeQueueRuns.length} active</span>
              {activeQueueRuns.length > 0 && (
                <span className="badge badge-green" style={{ animation: "pulse 1.5s infinite" }}>running</span>
              )}
              {/* Project filter — shown when there are multiple projects */}
              {projects.length > 1 && (
                <select
                  className="tl-select"
                  value={queueFilter}
                  onChange={e => setQueueFilter(e.target.value)}
                  style={{ height: 30, fontSize: "0.78rem", padding: "0 26px 0 9px", minWidth: 140 }}
                >
                  <option value="all">All projects</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {/* Apply project filter */}
          {(() => {
            const filteredActive = queueFilter === "all"
              ? activeQueueRuns
              : activeQueueRuns.filter(r => r.projectId === queueFilter);
            const filteredRecent = queueFilter === "all"
              ? recentQueueRuns
              : recentQueueRuns.filter(r => r.projectId === queueFilter);
            return (
              <>
                {filteredActive.length === 0 && filteredRecent.length === 0 && (
                  <div className="empty-state card">
                    <div className="empty-state-icon">⏳</div>
                    <div className="empty-state-title">
                      {queueFilter === "all" ? "No runs yet" : "No runs for this project"}
                    </div>
                    <div className="empty-state-desc">
                      {queueFilter === "all"
                        ? "Start a crawl or generate tests from a requirement to see them here."
                        : "Switch to a different project or start a new run."}
                    </div>
                  </div>
                )}

                {filteredActive.length > 0 && (
                  <>
                    <div className="section-label mb-sm">Active</div>
                    {filteredActive.map(run => (
                      <QueueRow
                        key={run.id}
                        run={run}
                        project={projects.find(p => p.id === run.projectId)}
                        onStop={handleQueueStop}
                        onAttach={handleAttachRun}
                      />
                    ))}
                  </>
                )}

                {filteredRecent.length > 0 && (
                  <>
                    <div className="section-label mb-sm" style={{ marginTop: 20 }}>Recent</div>
                    {filteredRecent.map(run => (
                      <QueueRow
                        key={run.id}
                        run={run}
                        project={projects.find(p => p.id === run.projectId)}
                        onStop={handleQueueStop}
                        onAttach={handleAttachRun}
                      />
                    ))}
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Recorder modal — launched from the topbar Record button. On save we
          bust the project cache (so the new draft test shows up in the Tests
          page and the launch panel's "Existing tests" stat) and navigate the
          user to the test detail view, mirroring Tests.jsx's onSaved flow. */}
      {showRecorder && selectedProject && (
        <RecorderModal
          open={showRecorder}
          onClose={() => setShowRecorder(false)}
          projectId={selectedProject.id}
          projects={projects}
          defaultUrl={selectedProject.url || ""}
          onSaved={(t) => {
            // Use the saved test's projectId — the user may have switched
            // projects inside the modal before launching the recording.
            invalidateProjectDataCache(t?.projectId || selectedProject.id);
            setShowRecorder(false);
            navigate(`/tests/${t.id}`);
          }}
        />
      )}

      {/* ── Crawl & Generate / Requirement tabs — 3-pane grid ── */}
      {(tab === "crawl" || tab === "requirement") && (
        <div className="tl-grid fade-in">

          {/* ── Left: Project sidebar ── */}
          <div className="tl-projects">
            <div className="tl-col-header">Projects</div>
            <div className="tl-proj-list">
              {loadingProjects
                ? [1, 2].map(i => (
                    <div key={i} className="skeleton" style={{ height: 48, borderRadius: 8, marginBottom: 4 }} />
                  ))
                : projects.map(p => (
                    <div
                      key={p.id}
                      className={`tl-proj-item${p.id === selectedId ? " tl-proj-item--active" : ""}`}
                      onClick={() => handleSelectProject(p.id)}
                    >
                      <ProjIcon project={p} />
                      <div className="tl-proj-info">
                        <div className="tl-proj-name">{p.name}</div>
                        <div className="tl-proj-url">{p.url?.replace(/^https?:\/\//, "")}</div>
                      </div>
                    </div>
                  ))
              }
            </div>

            {/* Last crawl meta */}
            {lastCrawlRun && (
              <div className="tl-proj-meta">
                <div className="tl-proj-meta-label">Last Crawl</div>
                <div className="tl-proj-meta-value">
                  {fmtRelativeDate(lastCrawlRun.startedAt)}
                </div>
                <div className="tl-proj-meta-value" style={{ marginTop: 2 }}>
                  {lastCrawlRun.pagesFound ?? "?"} pages · {lastCrawlRun.testsGenerated ?? "?"} tests
                </div>
              </div>
            )}
          </div>

          {/* ── Middle: Configuration / Running / Completed view ── */}
          {/* Show the run view (pipeline / sitegraph / logs) whenever a run is
              attached — running, completed, or failed. The user dismisses
              explicitly via the banner buttons below; without this, completed
              crawls would snap back to the config panel and the pipeline +
              site graph would vanish. */}
          {activeRun ? (
            // ── Attached run: pipeline + site graph + live log ──
            <div className="tl-run-center">
              <div className="tl-run-label">
                {selectedProject?.name?.toUpperCase()} · {activeRun?.type === "crawl" ? "LINK CRAWL" : "REQUIREMENT"}
                {isRunDone && <span style={{ marginLeft: 8, color: "var(--green)", fontWeight: 700 }}>· COMPLETED</span>}
                {isRunFailed && (
                  <span style={{ marginLeft: 8, color: "var(--red)", fontWeight: 700 }}>
                    · {runStatus === "aborted" ? "ABORTED" : "FAILED"}
                  </span>
                )}
              </div>

              {/* SSE reconnection / polling-fallback banners — only shown
                  while the run is actively running. Mirrors RunDetail.jsx so
                  users get the same feedback wherever they monitor a run. */}
              {isRunActive && retryIn != null && !sseDown && (
                <div className="banner banner-info" style={{ margin: "10px 14px 0", display: "flex", alignItems: "center", gap: 8 }}>
                  <RefreshCw size={13} style={{ flexShrink: 0 }} />
                  <span>Connection lost — reconnecting in {retryIn}s…</span>
                </div>
              )}
              {isRunActive && sseDown && (
                <div className="banner banner-warning" style={{ margin: "10px 14px 0", display: "flex", alignItems: "center", gap: 8 }}>
                  <RefreshCw size={13} className="spin" style={{ flexShrink: 0 }} />
                  <span>Live updates unavailable — refreshing every 5s.</span>
                </div>
              )}

              {/* Terminal banners — rendered at the top of the run view so the
                  pipeline / logs stay visible underneath for review. */}
              {isRunDone && (
                <div className="banner banner-success" style={{ margin: "10px 14px 0" }}>
                  <CheckCircle2 size={16} />
                  <div style={{ flex: 1 }}>
                    <strong>Generation complete</strong> — {runData?.testsGenerated ?? 0} test{(runData?.testsGenerated ?? 0) !== 1 ? "s" : ""} generated.
                    <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {(runData?.testsGenerated ?? 0) > 0 && (
                        <button
                          className="btn btn-primary btn-xs"
                          onClick={() => navigate(`/tests?filter=draft&projectId=${activeRun.projectId}`)}
                        >
                          Review {runData.testsGenerated} draft{runData.testsGenerated !== 1 ? "s" : ""} <ChevronRight size={12} />
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => navigate(`/runs/${activeRun.runId}`)}
                      >
                        View run <ChevronRight size={12} />
                      </button>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={handleReset}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {isRunFailed && (
                <div className="banner banner-error" style={{ margin: "10px 14px 0" }}>
                  <div>
                    <strong>{runStatus === "aborted" ? "Run aborted" : "Run failed"}</strong>
                    {runData?.error ? ` — ${runData.error}` : "."}
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ marginLeft: 10 }}
                      onClick={() => navigate(`/runs/${activeRun.runId}`)}
                    >
                      View run <ChevronRight size={12} />
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ marginLeft: 6 }}
                      onClick={handleReset}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              {(() => {
                // Site Graph is only meaningful for crawl runs — the
                // requirement flow doesn't produce a page graph. Same shape as
                // CrawlView's `graphPages` derivation (`run.pages` or
                // `run.snapshots`, normalised to an array).
                const isCrawl = activeRun?.type === "crawl";
                const rawPages = runData?.pages ?? runData?.snapshots ?? [];
                const graphPages = Array.isArray(rawPages)
                  ? rawPages
                  : (typeof rawPages === "object" ? Object.values(rawPages) : []);
                // Derive the page currently being crawled from the latest log
                // line — mirrors CrawlView.jsx:48-54.
                let activePage = null;
                for (let i = logLines.length - 1; i >= 0; i--) {
                  const m = logLines[i].match(/https?:\/\/[^\s)]+/);
                  if (m) { activePage = m[0]; break; }
                }
                const innerTabs = isCrawl
                  ? ["pipeline", "sitegraph", "logs"]
                  : ["pipeline", "logs"];
                const labelFor = (t) => t === "sitegraph" ? "Site graph"
                  : t.charAt(0).toUpperCase() + t.slice(1);
                return (
                  <>
                    <div className="tl-inner-tabs">
                      {innerTabs.map(t => (
                        <button
                          key={t}
                          className={`tl-inner-tab${innerTab === t ? " tl-inner-tab--active" : ""}`}
                          onClick={() => setInnerTab(t)}
                        >
                          {labelFor(t)}
                        </button>
                      ))}
                    </div>

                    {/* ── Pipeline tab: 3-sub-column — Pipeline | Live Output | So Far ── */}
                    {innerTab === "pipeline" && (
                      <div className="tl-pipeline-view">
                        {/* Sub-col 1: stage list */}
                        <div className="tl-pipeline-col">
                          {/* Progress label */}
                          <div className="tl-pipeline-progress-label">
                            {runData?.currentStep != null && runData.status === "running"
                              ? `Step ${runData.currentStep} of 8 · ${PIPELINE_STAGES[runData.currentStep - 1]?.label ?? ""}`
                              : runData?.status === "completed" || runData?.status === "completed_empty"
                                ? "Completed"
                                : runData?.status === "failed" ? "Failed"
                                : runData?.status === "aborted" ? "Aborted"
                                : "Starting…"}
                          </div>
                          {/* Progress bar */}
                          <div className="progress-bar" style={{ margin: "6px 0 10px" }}>
                            <div
                              className="progress-bar-fill"
                              style={{
                                width: isRunDone ? "100%"
                                  : runData?.currentStep != null
                                    ? `${Math.round(((runData.currentStep - 1) / 7) * 100)}%`
                                    : "0%",
                              }}
                            />
                          </div>
                          <PipelinePanel run={runData} />
                        </div>

                        {/* Sub-col 2: live log */}
                        <div className="tl-pipeline-log-col">
                          <div className="tl-pipeline-col-label">Live Output</div>
                          <LiveLog lines={logLines} />
                        </div>

                        {/* Sub-col 3: so far stats + stop button */}
                        <div className="tl-pipeline-stats-col">
                          <div className="tl-pipeline-col-label">So Far</div>
                          <div className="tl-run-stats">
                            <div className="tl-run-stat tl-run-stat--accent">
                              <div className="tl-run-stat-val">{ps.rawTestsGenerated ?? runData?.testsGenerated ?? 0}</div>
                              <div className="tl-run-stat-lbl">Generated</div>
                            </div>
                            <div className="tl-run-stat tl-run-stat--amber">
                              <div className="tl-run-stat-val">{ps.duplicatesRemoved ?? 0}</div>
                              <div className="tl-run-stat-lbl">Dupes removed</div>
                            </div>
                            <div className="tl-run-stat tl-run-stat--green">
                              <div className="tl-run-stat-val">
                                {ps.averageQuality != null ? ps.averageQuality : "—"}
                              </div>
                              <div className="tl-run-stat-lbl">Avg quality</div>
                            </div>
                            <div className="tl-run-stat">
                              <div className="tl-run-stat-val" style={{ color: "var(--text)" }}>
                                {ps.pagesFound ?? runData?.pagesFound ?? 0}
                              </div>
                              <div className="tl-run-stat-lbl">Pages crawled</div>
                            </div>
                          </div>

                          {isRunActive ? (
                            <button
                              className="btn btn-ghost"
                              style={{ width: "100%", justifyContent: "center", gap: 6, marginTop: 12 }}
                              onClick={handleStop}
                              disabled={stopLoading}
                            >
                              <StopCircle size={15} />
                              {stopLoading ? "Stopping…" : "Stop run"}
                            </button>
                          ) : !isRunDone && !isRunFailed ? null : (
                            <button
                              className="btn btn-ghost"
                              style={{ width: "100%", justifyContent: "center", gap: 6, marginTop: 12 }}
                              onClick={handleReset}
                            >
                              New run
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {innerTab === "sitegraph" && isCrawl && (
                      <div style={{ flex: 1, overflow: "auto", padding: 14 }}>
                        <SiteGraph
                          pages={graphPages}
                          activePage={activePage}
                          isRunning={isRunActive}
                        />
                      </div>
                    )}

                    {innerTab === "logs" && (
                      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                        <LiveLog lines={logLines} />
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          ) : (
            // ── Idle / Done: configuration ──
            <div className="tl-config">
              <div className="tl-config-scroll">

                {/* Error banner — launch-time errors only; run-terminal
                    banners live inside the run-center view above. */}
                {error && (
                  <div className="banner banner-error mb-md">
                    {error}
                  </div>
                )}

                {/* ── Requirement input + extras (Requirement tab only) ── */}
                {tab === "requirement" && (
                  <>
                    {/* Test Name override — optional. Blank = auto-derive
                        from the first line of the requirement at submit. */}
                    <div className="tl-section">
                      <div className="tl-section-label">
                        Test Name
                        <span style={{ marginLeft: 6, color: "var(--text3)", fontWeight: 400, textTransform: "none", letterSpacing: "normal" }}>
                          (optional — auto-derived from the requirement if blank)
                        </span>
                      </div>
                      <input
                        className="tl-select"
                        type="text"
                        value={testName}
                        onChange={e => setTestName(e.target.value)}
                        placeholder="e.g. Dashboard loads all employee charts"
                        style={{ width: "100%", backgroundImage: "none", paddingRight: 10, height: 36 }}
                      />
                    </div>

                    {/* Requirement composer — single inline surface that
                        bundles attachment chips, the textarea, and an action
                        toolbar (📎 attach, Import Issue) below the input.
                        Mirrors the chat-style composer pattern from
                        ChatGPT / Claude / Cursor: file uploads aren't a
                        separate section, they're an inline affordance on the
                        message you're writing. */}
                    <div className="tl-section">
                      <div className="tl-section-label">Requirement / User Story</div>

                      {showImportIssue && (
                        <div className="tl-import-issue">
                          <div style={{ fontSize: "0.78rem", color: "var(--text2)", fontWeight: 500 }}>
                            Paste a Jira issue (title on first line, description below)
                          </div>
                          <textarea
                            className="tl-req-area"
                            value={importIssueText}
                            onChange={e => setImportIssueText(e.target.value)}
                            placeholder={"PROJ-123 Login fails for SSO users\nAs a user with SSO enabled I expect to be redirected to the IdP…"}
                            rows={4}
                            style={{ minHeight: 88, marginBottom: 0 }}
                            autoFocus
                          />
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button
                              className="btn btn-ghost btn-xs"
                              onClick={() => { setShowImportIssue(false); setImportIssueText(""); }}
                            >
                              Cancel
                            </button>
                            <button
                              className="btn btn-primary btn-xs"
                              onClick={handleImportIssue}
                              disabled={!importIssueText.trim()}
                            >
                              Import
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="tl-composer">
                        {/* Attachment chips — render inline above the
                            textarea (like Claude / ChatGPT) so users see what's
                            attached as part of the message they're sending. */}
                        {attachments.length > 0 && (
                          <div className="tl-composer-chips">
                            {attachments.map(a => (
                              <span key={a.name} className="tl-attachment-chip" title={`${Math.round(a.content.length / 1000)}k chars`}>
                                <Paperclip size={11} />
                                <span className="tl-attachment-chip-name">{a.name}</span>
                                <button
                                  type="button"
                                  className="tl-attachment-chip-remove"
                                  onClick={() => removeAttachment(a.name)}
                                  title="Remove attachment"
                                  aria-label={`Remove ${a.name}`}
                                >
                                  <Trash2 size={10} />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}

                        <textarea
                          ref={requirementRef}
                          className="tl-req-area tl-composer-area"
                          placeholder={"As a user I want to search for items so that I can find what I'm looking for…"}
                          value={requirement}
                          onChange={e => setRequirement(e.target.value)}
                          // Cmd/Ctrl+Enter submits — matches GenerateTestModal's
                          // single-key submit, but scoped to a modifier so plain
                          // Enter still inserts a newline in this multi-line area.
                          onKeyDown={e => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              if (requirement.trim() && selectedProject && !launching) {
                                handleGenerateFromRequirement();
                              }
                            }
                          }}
                          rows={5}
                        />

                        {/* Action toolbar — paperclip + Import Issue render
                            inside the composer footer, ChatGPT-style, so
                            attachments aren't a parallel section the user has
                            to scroll past. */}
                        <div className="tl-composer-toolbar">
                          <button
                            type="button"
                            className="tl-composer-action"
                            onClick={() => fileInputRef.current?.click()}
                            title="Attach a text file (.md, .json, .yaml, .feature, …)"
                          >
                            <Paperclip size={13} />
                            <span>Attach</span>
                          </button>
                          <button
                            type="button"
                            className="tl-composer-action"
                            onClick={() => setShowImportIssue(v => !v)}
                            title="Paste a Jira / GitHub issue and auto-split into name + description"
                          >
                            <Upload size={13} />
                            <span>Import issue</span>
                          </button>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept={ACCEPTED_EXTENSIONS}
                            multiple
                            onChange={handleFileSelect}
                            style={{ display: "none" }}
                          />
                          <span className="tl-composer-hint">
                            <kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> to generate
                          </span>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* ── Unified Test Dials surface ──
                    Crawl tab gets the Explorer sub-tab (discovery mode + state-
                    explorer tuning); Requirement tab hides it because the
                    requirement flow doesn't crawl. The component is fully
                    controlled — `dialsConfig` is the single source of truth and
                    feeds the API call sites directly. */}
                <TestConfig
                  value={dialsConfig}
                  onChange={setDialsConfig}
                  showExplorer={tab === "crawl"}
                  // Crawl tab: pick-a-URL vs. explore-state is the most
                  // consequential choice on this flow, so we lift it out of
                  // the sub-tab strip and render it as a prominent header.
                  // Requirement tab keeps the sub-tab layout (no crawl ⇒ no
                  // discovery decision to make).
                  showDiscoveryHeader={tab === "crawl"}
                  // `parallelWorkers` is consumed only by the test runner
                  // (POST /projects/:id/run → testRunner.js). Both Test Lab
                  // flows are pre-runner (crawl + AI generation), so the
                  // backend silently ignores the field — hiding it avoids
                  // surfacing a no-op control to users.
                  showRunnerOptions={false}
                />
              </div>
            </div>
          )}

          {/* ── Right: Launch panel / Run stats ── */}
          <div className="tl-panel">
            <div className="tl-panel-scroll">

              {activeRun ? (
                // ── Attached run: stats now live inline in the pipeline view.
                // Right panel shows a minimal context card + quick navigation.
                <>
                  <div className="tl-panel-section-label">
                    {isRunActive ? "Running" : isRunDone ? "Completed" : "Stopped"}
                  </div>
                  <div className="tl-stat-cell" style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>
                      {selectedProject?.name ?? "—"}
                    </div>
                    <div style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                      {activeRun?.type === "crawl" ? "Crawl & Generate" : "From Requirement"}
                    </div>
                  </div>

                  {/* Final test count — shown when done */}
                  {(isRunDone || isRunFailed) && (
                    <div className="tl-run-stats" style={{ marginBottom: 12 }}>
                      <div className="tl-run-stat tl-run-stat--accent">
                        <div className="tl-run-stat-val">{runData?.testsGenerated ?? 0}</div>
                        <div className="tl-run-stat-lbl">Tests generated</div>
                      </div>
                      <div className="tl-run-stat tl-run-stat--green">
                        <div className="tl-run-stat-val">
                          {ps.averageQuality != null ? ps.averageQuality : "—"}
                        </div>
                        <div className="tl-run-stat-lbl">Avg quality</div>
                      </div>
                    </div>
                  )}

                  <hr className="tl-panel-divider" />

                  {isRunActive ? (
                    <button
                      className="btn btn-ghost"
                      style={{ width: "100%", justifyContent: "center", gap: 6 }}
                      onClick={handleStop}
                      disabled={stopLoading}
                    >
                      <StopCircle size={15} />
                      {stopLoading ? "Stopping…" : "Stop run"}
                    </button>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {isRunDone && (runData?.testsGenerated ?? 0) > 0 && (
                        <button
                          className="btn btn-primary"
                          style={{ width: "100%", justifyContent: "center", gap: 6 }}
                          onClick={() => navigate(`/tests?filter=draft&projectId=${activeRun.projectId}`)}
                        >
                          Review {runData.testsGenerated} draft{runData.testsGenerated !== 1 ? "s" : ""} <ChevronRight size={13} />
                        </button>
                      )}
                      <button
                        className="btn btn-ghost"
                        style={{ width: "100%", justifyContent: "center", gap: 6 }}
                        onClick={() => navigate(`/runs/${activeRun.runId}`)}
                      >
                        View run detail <ChevronRight size={13} />
                      </button>
                      <button
                        className="btn btn-ghost"
                        style={{ width: "100%", justifyContent: "center", gap: 6 }}
                        onClick={handleReset}
                      >
                        New run
                      </button>
                    </div>
                  )}
                </>
              ) : (
                // ── Idle: launch panel + cross-project active runs ──
                <>
                  {tab === "crawl" && (
                    <>
                      <div className="tl-panel-section-label">Ready to Launch</div>
                      <div className="tl-launch-stats">
                        <div className="tl-stat-cell">
                          <div className="tl-stat-val">
                            {pagesFound != null ? pagesFound : <span style={{ color: "var(--text3)" }}>—</span>}
                          </div>
                          <div className="tl-stat-lbl">Pages found</div>
                        </div>
                        <div className="tl-stat-cell">
                          <div className="tl-stat-val">
                            {existingTests != null ? existingTests : <span style={{ color: "var(--text3)" }}>—</span>}
                          </div>
                          <div className="tl-stat-lbl">Existing tests</div>
                        </div>
                      </div>

                      {pagesFound != null && (
                        <div className="tl-estimate">
                          Estimated: <strong>8–15 new tests</strong> · ~4 min
                        </div>
                      )}
                    </>
                  )}

                  {tab === "requirement" && (
                    <>
                      <div className="tl-panel-section-label">Ready to Launch</div>
                      <div className="tl-launch-stats">
                        <div className="tl-stat-cell">
                          <div className="tl-stat-val">
                            {existingTests != null ? existingTests : <span style={{ color: "var(--text3)" }}>—</span>}
                          </div>
                          <div className="tl-stat-lbl">Existing tests</div>
                        </div>
                        <div className="tl-stat-cell">
                          <div className="tl-stat-val" style={{ fontSize: "1rem", paddingTop: 4 }}>
                            {requirement.trim() ? "Ready" : <span style={{ color: "var(--text3)" }}>—</span>}
                          </div>
                          <div className="tl-stat-lbl">Requirement</div>
                        </div>
                      </div>
                      {requirement.trim() && (
                        <div className="tl-estimate">
                          Focused generation: <strong>1–5 new tests</strong> · ~1–2 min
                        </div>
                      )}
                      <hr className="tl-panel-divider" />
                      <div className="tl-panel-section-label">Examples</div>
                      {REQ_EXAMPLES.map(ex => (
                        <button
                          key={ex}
                          className="tl-example"
                          onClick={() => setRequirement(ex)}
                        >
                          {ex}
                        </button>
                      ))}
                      <hr className="tl-panel-divider" />
                    </>
                  )}

                  {/* CTA */}
                  {!selectedProject && (
                    <div className="banner banner-warning mb-md">
                      Select a project to continue.
                    </div>
                  )}

                  {tab === "crawl" && (
                    <button
                      className="btn btn-primary"
                      style={{ width: "100%", justifyContent: "center", gap: 6, padding: "10px 16px" }}
                      disabled={!selectedProject || launching}
                      onClick={handleStartCrawl}
                    >
                      {launching ? (
                        <><span className="spin"><RotateCcw size={15} /></span> Starting…</>
                      ) : (
                        <><Play size={15} /> Start Crawl &amp; Generate</>
                      )}
                    </button>
                  )}

                  {tab === "requirement" && (
                    <button
                      className="btn btn-primary"
                      style={{ width: "100%", justifyContent: "center", gap: 6, padding: "10px 16px" }}
                      disabled={!selectedProject || !requirement.trim() || launching}
                      onClick={handleGenerateFromRequirement}
                    >
                      {launching ? (
                        <><span className="spin"><RotateCcw size={15} /></span> Generating…</>
                      ) : (
                        <><Zap size={15} /> Generate Tests</>
                      )}
                    </button>
                  )}

                  <hr className="tl-panel-divider" />
                  <div className="tl-panel-section-label">Active Runs</div>

                  {activeQueueRuns.length === 0 ? (
                    <div className="tl-active-run-empty">No active runs</div>
                  ) : (
                    activeQueueRuns.slice(0, 3).map(run => {
                      const proj = projects.find(p => p.id === run.projectId);
                      const pct  = run.currentStep != null
                        ? Math.round(((run.currentStep - 1) / 7) * 100)
                        : 0;
                      return (
                        <button
                          key={run.id}
                          type="button"
                          className="tl-active-run-card mb-sm"
                          onClick={() => handleAttachRun(run)}
                          title="View live pipeline for this run"
                          style={{
                            display: "block", width: "100%", textAlign: "left",
                            padding: 0, border: "1px solid var(--border)",
                            background: "var(--surface)", cursor: "pointer",
                            font: "inherit", color: "inherit",
                          }}
                        >
                          <div className="tl-arc-header">
                            <ProjIcon project={proj} />
                            <span className="tl-arc-name">{proj?.name ?? "—"}</span>
                            <span className="badge badge-blue" style={{ fontSize: "0.65rem", animation: "pulse 1.5s infinite" }}>live</span>
                          </div>
                          <div className="tl-arc-body">
                            <div className="tl-arc-step">
                              Step {run.currentStep ?? "?"}/8 · {PIPELINE_STAGES[(run.currentStep ?? 1) - 1]?.label}
                            </div>
                            <div className="progress-bar">
                              <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        </button>
                      );
                    })
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
