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
// G9 — parallel runs. Today only mounts the drawer + maintains a parallel
// state shape; the single-run `useRunSSE` above still drives the live SSE
// connection. Follow-up PR migrates the SSE driver itself to
// `useMultiRunSSE` and deletes the single-run state.
import { useMultiRunSSE } from "../hooks/useMultiRunSSE.js";
import RunDrawer from "../components/test-lab/RunDrawer.jsx";
import useProjectData, { invalidateProjectDataCache } from "../hooks/useProjectData.js";
import usePageTitle from "../hooks/usePageTitle.js";
import { fmtRelativeDate } from "../utils/formatters.js";
import SiteGraph from "../components/crawl/SiteGraph.jsx";
import RecorderModal from "../components/run/RecorderModal.jsx";
import TestConfig from "../components/test/TestConfig.jsx";
import EmptyState from "../components/shared/EmptyState.jsx";
// Task 3 — multi-agent chat transcript replaces the prior single-narrator
// `NarrativeFeed` (which lived inline in this file). `AgentConversation`
// owns its own `getStageAgentRoles` import from `frontend/src/config.js`,
// so step → role attribution stays anchored to the canonical map without
// prop-drilling through TestLab.
import AgentConversation from "../components/ai/AgentConversation.jsx";
// `stageStatus` extracted to a shared util so AgentConversation and any
// future stage-aware view derive state from the same single source. See
// `frontend/src/utils/pipelineState.js` for status semantics.
import { stageStatus } from "../utils/pipelineState.js";
import { loadSavedConfig } from "../utils/testDialsStorage.js";
// AGENT.md §40 — helpers used by ≥2 call sites live in `utils/`, not inline.
// `TestLabTabs` + `RetryButton` extracted from the inline IIFE + duplicated
// banner/panel JSX that previously lived in this file.
import TestLabTabs from "../components/test-lab/TestLabTabs.jsx";
import RetryButton from "../components/test-lab/RetryButton.jsx";
import { buildRetryPayload, resolveGenerateRetryFields } from "../utils/runRetry.js";


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

// GAP-005 (audit, fix) — `STEP_TO_AGENT_ROLE` removed in favour of the
// shared `getStageAgentRoles` helper imported above. The old map was both
// incomplete (only `planner` + `author`, missing `explorer` and 3 other
// configurable roles) and wrong on step 3 (the real call site is
// `backend/src/pipeline/intentClassifier.js#L158` with `explorer`, plus
// `journeyGenerator.js#L218` with `planner` — multi-agent stage).

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
// `stageStatus` previously lived inline here; it's now imported from
// `frontend/src/utils/pipelineState.js` so AgentConversation (and any
// future stage-aware surface) shares the single source of truth.

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
              <span className="tl-stage-stat tl-stage-stat--running">running…</span>
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
        <span className="badge badge-green tl-queue-row__pin">done</span>
      )}
      {isFailed && (
        <span className="badge badge-red tl-queue-row__pin">failed</span>
      )}
      {isAborted && (
        <span className="badge badge-amber tl-queue-row__pin">aborted</span>
      )}

      {isActive ? (
        <>
          <button
            className="btn btn-ghost btn-sm tl-queue-row__pin"
            onClick={() => onAttach?.(run)}
            title="Attach the live pipeline view to this run"
          >
            View <ArrowRight size={13} />
          </button>
          <button
            className="btn btn-ghost btn-sm tl-queue-row__pin"
            onClick={() => onStop(run.id)}
          >
            <StopCircle size={14} />
            Stop
          </button>
        </>
      ) : (
        <button
          className="btn btn-ghost btn-sm tl-queue-row__pin"
          onClick={() => navigate(`/runs/${run.id}`)}
        >
          View <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}

// ── (NarrativeFeed removed — see `frontend/src/components/ai/AgentConversation.jsx`)
//
// Task 3 replaced the inline single-narrator NarrativeFeed with the
// multi-agent AgentConversation transcript. The supporting NARRATIVE_STAGES
// array (per-stage line scripts) + the resolveNarrativeLine helper + the
// `tl-nf-*` CSS in `pages/test-lab.css` are all dead code now and removed.
// AgentConversation is imported above and rendered below in place of
// `<NarrativeFeed>`.

// (NARRATIVE_STAGES + resolveNarrativeLine removed — superseded by
// AgentConversation's per-agent TURN_TEMPLATES.)

// (NarrativeFeed body removed — replaced by AgentConversation.)

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

  // G9 — parallel-runs state. Lives ALONGSIDE the single-run state above
  // during the migration window. Every launch / attach / dismiss handler
  // mirrors writes into both shapes so render paths can be migrated
  // incrementally without breaking the single-run consumers. The next
  // PR deletes the single-run state and reads only from these Maps.
  //
  // Maps preserve insertion order — cards in `<RunDrawer>` render
  // oldest-first, which matches user expectation ("I started A first,
  // then B").
  //
  //   activeRuns:        Map<runId, { runId, projectId, type }>
  //   runDataByRunId:    Map<runId, RunData>            // SSE snapshot for each
  //   logLinesByRunId:   Map<runId, string[]>           // tail-capped at LOG_CAP
  //   focusedRunId:      string | null                  // which card is selected
  //
  // `focusedRunId` mirrors `activeRun.runId` today (single-run mode).
  // When the drawer's "+ New run" UX lands, focusing null means "show
  // the config panel"; the middle column reads `focusedRunId` instead
  // of `activeRun` so an unfocused-but-active run still ticks in the
  // background without dominating the view.
  const [activeRuns, setActiveRuns] = useState(() => {
    const m = new Map();
    if (persisted?.activeRun?.runId) {
      m.set(persisted.activeRun.runId, persisted.activeRun);
    }
    return m;
  });
  const [runDataByRunId, setRunDataByRunId] = useState(() => {
    const m = new Map();
    if (persisted?.activeRun?.runId && persisted?.runData) {
      m.set(persisted.activeRun.runId, persisted.runData);
    }
    return m;
  });
  const [logLinesByRunId, setLogLinesByRunId] = useState(() => {
    const m = new Map();
    if (persisted?.activeRun?.runId) {
      m.set(persisted.activeRun.runId, persisted.logLines ?? []);
    }
    return m;
  });
  const [focusedRunId, setFocusedRunId] = useState(persisted?.activeRun?.runId ?? null);

  // G9 — multi-run SSE pool. Today this hook is mounted but NOT used as
  // the SSE driver for the focused run (the single-run `useRunSSE` call
  // below still owns that). The pool's `activeRunIds` is informational
  // for the next-PR migration; subscribing additional runs through it
  // would race against the single-run driver if they shared a runId.
  // Once the migration completes, the single-run hook is removed and
  // every active run subscribes through this pool.
  const multiSse = useMultiRunSSE();

  // ── Queue state ──
  const [queueFilter, setQueueFilter]   = useState("all");

  // ── Recorder state ──
  // Recording stays as a modal (not a tab) because it's inherently
  // overlay-oriented — the live screencast preview needs a focused surface.
  // The Test Lab page just provides a launch point so users don't have to
  // bounce back to the Tests page to start a recording session.
  const [showRecorder, setShowRecorder] = useState(false);

  // ── DIF-012: per-project environments (crawl + generate + recorder) ──
  // Fetched lazily on project change; viewer roles get a 403 which we swallow
  // (the picker hides itself when the list is empty). `environmentId === ""`
  // means "default — use project.url"; the API call omits the field entirely.
  const [environments, setEnvironments] = useState([]);
  const [environmentId, setEnvironmentId] = useState("");
  useEffect(() => {
    if (!selectedId) { setEnvironments([]); setEnvironmentId(""); return; }
    let cancelled = false;
    setEnvironmentId("");
    api.getProjectEnvironments(selectedId)
      .then((rows) => { if (!cancelled) setEnvironments(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setEnvironments([]); }); // 403 for viewers — clutter-free
    return () => { cancelled = true; };
  }, [selectedId]);

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
  // G9 — every state write here mirrors into the parallel-runs Maps so the
  // drawer card for `activeRun.runId` ticks in real time. The single-run
  // `setRunData` / `setLogLines` calls remain in place during the
  // migration window. The mirror is guarded by `activeRun?.runId` — if
  // the user dismisses the run mid-event the mirror no-ops rather than
  // writing to a stale key.
  const handleSSEEvent = useCallback((event) => {
    const mirrorRunId = activeRun?.runId;
    if (event.type === "snapshot" && event.run) {
      // Snapshot carries the full `agentEvents[]` history hydrated by the
      // backend (see `backend/src/routes/sse.js#L170-L182`). Spread first
      // so the snapshot's array becomes the authoritative seed for the
      // local buffer — subsequent live `agent_event` pushes append below.
      setRunData(prev => ({ ...prev, ...event.run }));
      if (mirrorRunId) {
        setRunDataByRunId(prev => {
          const next = new Map(prev);
          next.set(mirrorRunId, { ...(prev.get(mirrorRunId) || {}), ...event.run });
          return next;
        });
      }
    }
    if (event.type === "run_update" || event.type === "update") {
      setRunData(prev => ({ ...prev, ...event.run }));
      if (mirrorRunId) {
        setRunDataByRunId(prev => {
          const next = new Map(prev);
          next.set(mirrorRunId, { ...(prev.get(mirrorRunId) || {}), ...event.run });
          return next;
        });
      }
    }
    if (event.type === "log" && event.message) {
      // Cap in-memory log buffer to bound memory + avoid O(n²) re-allocation
      // on long runs. `LiveLog` only renders the last 40 lines anyway, and
      // `persistRun` already caps its sessionStorage copy at LOG_CAP.
      setLogLines(prev => {
        const next = [...prev, event.message];
        return next.length > LOG_CAP ? next.slice(-LOG_CAP) : next;
      });
      if (mirrorRunId) {
        setLogLinesByRunId(prev => {
          const next = new Map(prev);
          const cur = prev.get(mirrorRunId) || [];
          const appended = [...cur, event.message];
          next.set(mirrorRunId, appended.length > LOG_CAP ? appended.slice(-LOG_CAP) : appended);
          return next;
        });
      }
    }
    // Task 2 — per-agent SSE event. The backend emits one of these per LLM
    // call-site lifecycle phase (start | progress | finding | handoff | done)
    // via `emitAgentEvent` in `backend/src/aiProvider/agentEventEmitter.js`.
    // We append to the local `runData.agentEvents` buffer (seeded from the
    // snapshot above) so consumers — today the `<AgentConversation>` synth
    // adapter, tomorrow a real-event renderer — can read the full per-agent
    // narrative without a separate REST round-trip. Each push carries
    // `{ step, agent, phase, message, data, nextAgent, model, createdAt }`;
    // `data` is already a structured object on the wire (the emitter
    // unifies the shape between persist + broadcast).
    if (event.type === "agent_event") {
      const { type: _type, ...evt } = event;
      setRunData(prev => {
        const prevEvents = Array.isArray(prev?.agentEvents) ? prev.agentEvents : [];
        return { ...prev, agentEvents: [...prevEvents, evt] };
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
      if (mirrorRunId) {
        setRunDataByRunId(prev => {
          const next = new Map(prev);
          next.set(mirrorRunId, { ...(prev.get(mirrorRunId) || {}), ...(event.run || {}), status: terminalStatus });
          return next;
        });
      }
      // Bust the shared cache so the Queue tab and Active-Runs panel pick up
      // the final test count / failure state without waiting for staleTime.
      invalidateProjectDataCache();
    }
    // G9 — agent_event mirror. Same pattern as snapshot/update above.
    if (event.type === "agent_event" && mirrorRunId) {
      const { type: _t, ...evt } = event;
      setRunDataByRunId(prev => {
        const next = new Map(prev);
        const cur = prev.get(mirrorRunId) || {};
        const curEvents = Array.isArray(cur.agentEvents) ? cur.agentEvents : [];
        next.set(mirrorRunId, { ...cur, agentEvents: [...curEvents, evt] });
        return next;
      });
    }
    // G9 — `activeRun?.runId` is read above as `mirrorRunId`. Adding
    // `activeRun` to the dep array would invalidate the SSE handler on
    // every launch — `useRunSSE` re-subscribes when its handler ref
    // changes, which means every new run would tear down + recreate the
    // SSE connection of the previous run. Instead we accept a one-
    // event-window staleness: when the user dismisses a run and
    // launches another within the same React frame, the first SSE
    // event for the new run still mirrors to the OLD `mirrorRunId`.
    // The next handler render fixes it. In practice the launch path
    // calls `setActiveRun` synchronously which forces a render before
    // the first SSE event can arrive (network round-trip > React
    // render), so the window is empty under normal latency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.runId]);

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

  // ── Auto-attach to a server-side running run on mount ──
  // sessionStorage-based rehydration only covers the single-tab case (a user
  // who started the crawl in *this* tab and stayed inside the SPA). Three
  // real cases break it:
  //   1. New tab — sessionStorage is empty even though a run is executing.
  //   2. User switches to a different project's TestLab — sessionStorage
  //      holds the *other* project's run and the new project's running
  //      crawl is invisible until they click Queue.
  //   3. Hard reload mid-run — sessionStorage survives, but on browsers/
  //      modes where it doesn't (private mode), we'd still drop the run.
  //
  // `allRuns` (TanStack Query cache, populated by `useProjectData`) is the
  // server's authoritative list of running runs. When the panel is idle and
  // there's a generation run executing for the selected project, attach to
  // it automatically — same effect as the user clicking "View" in the
  // Queue tab, but without making them find it. `attachedFromQueueRef`
  // prevents the effect from re-firing every time `allRuns` refreshes.
  const attachedFromQueueRef = useRef(false);
  useEffect(() => {
    // G10 — the auto-attach effect runs only when NOTHING is attached.
    // Pre-fix it re-fired on every `selectedId` change too, which after
    // the project-switch decoupling above would silently swap the live
    // view between projects: user starts crawl on A, clicks B in the
    // sidebar, and if B happens to have a running run the effect
    // overwrites A's `activeRun` with B's. The user loses A's live view
    // without any action that intended to drop it.
    //
    // The fix is conservative — auto-attach only when `activeRun` is
    // null. If the user wants to switch to a sibling project's running
    // run, they use the right-rail "Active runs" list which goes
    // through `handleAttachRun` explicitly. The effect's `selectedId`
    // dep is preserved so a future project change on an idle view
    // still discovers running runs.
    if (activeRun) { attachedFromQueueRef.current = false; return; }
    if (attachedFromQueueRef.current) return;
    if (!selectedId) return;
    const candidate = allRuns.find(
      (r) => r.projectId === selectedId
        && (r.type === "crawl" || r.type === "generate")
        && r.status === "running",
    );
    if (!candidate) return;
    attachedFromQueueRef.current = true;
    handleAttachRun(candidate);
    // `handleAttachRun` is defined below in the component — declared as a
    // function so it's hoisted for this effect's reference. It's stable
    // across renders (no closure dependencies that would change between
    // calls).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun, selectedId, allRuns]);

  // ── Backfill missing log lines on remount ──
  // SSE has no replay cursor — `useRunSSE` (`hooks/useRunSSE.js:114-134`) only
  // forwards messages emitted *after* its EventSource opens. If the user
  // navigated away mid-pipeline, any log lines emitted while they were on
  // another page are missing from the rehydrated `logLines` slice.
  //
  // Backend ENH-008 persists every log line in the `run_logs` table and
  // `GET /api/v1/runs/:id` hydrates `run.logs` from that table (see
  // `backend/src/database/repositories/runRepo.js:272-287`), so a single
  // fetch on mount restores the complete history. Subsequent SSE messages
  // append from the reconnect point as usual.
  //
  // Guarded with a ref so it runs at most once per `activeRun.runId` — without
  // this, every SSE update that mutates `runData` would re-trigger the effect
  // and we'd refetch the full log on every render.
  const backfilledRunIdRef = useRef(null);
  useEffect(() => {
    if (!activeRun?.runId) return;
    if (backfilledRunIdRef.current === activeRun.runId) return;
    if (!persisted || persisted.activeRun?.runId !== activeRun.runId) {
      // Only backfill on rehydration — runs started fresh in-page already
      // have their logs streamed from the start.
      backfilledRunIdRef.current = activeRun.runId;
      return;
    }
    backfilledRunIdRef.current = activeRun.runId;
    let cancelled = false;
    api.getRun(activeRun.runId)
      .then((run) => {
        if (cancelled) return;
        const serverLogs = Array.isArray(run?.logs) ? run.logs : [];
        if (serverLogs.length === 0) return;
        // Merge: prefer the server's authoritative copy. Cap at LOG_CAP so a
        // long run doesn't blow past the in-memory bound that `setLogLines`
        // enforces elsewhere.
        setLogLines((prev) => {
          // If we already have ≥ server's count, the user never lost any
          // lines (they stayed on Test Lab); keep the local copy intact.
          if (prev.length >= serverLogs.length) return prev;
          const merged = serverLogs.slice(-LOG_CAP);
          return merged;
        });
      })
      .catch(() => { /* non-fatal — keep whatever we rehydrated */ });
    return () => { cancelled = true; };
  }, [activeRun?.runId, persisted]);

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
      // DIF-012: only send environmentId when the user picked a non-default
      // option — sending "" would force the backend's validator to run an
      // extra lookup. Mirrors the RunRegressionModal payload shape.
      const body = { dialsConfig };
      if (environmentId) body.environmentId = environmentId;
      const { runId } = await api.crawl(selectedId, body);
      const entry = { runId, projectId: selectedId, type: "crawl" };
      setActiveRun(entry);
      setInnerTab("pipeline");
      // G9 — register in the parallel-runs Map + focus this run so the
      // drawer card appears immediately. Subsequent SSE snapshots
      // populate `runDataByRunId` via the handler's mirror.
      setActiveRuns(prev => {
        const next = new Map(prev);
        next.set(runId, entry);
        return next;
      });
      setFocusedRunId(runId);
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
      const genBody = {
        name: finalName,
        description: fullDescription,
        dialsConfig,
      };
      // DIF-012: mirror the crawl path — only send when non-default.
      if (environmentId) genBody.environmentId = environmentId;
      const { runId } = await api.generateTest(selectedId, genBody);
      // Use backend's canonical type name (`"generate"`) so
      // `activeRun.type` matches `run.type` on re-attach and any future
      // strict equality checks don't silently fork.
      const entry = { runId, projectId: selectedId, type: "generate" };
      setActiveRun(entry);
      setInnerTab("pipeline");
      // G9 — see handleStartCrawl mirror block.
      setActiveRuns(prev => {
        const next = new Map(prev);
        next.set(runId, entry);
        return next;
      });
      setFocusedRunId(runId);
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
    // G9 — `handleReset` is the "Dismiss" / "New run" path. Today it
    // mirrors into the Maps too, removing the previously-focused run
    // entirely. Once a user has multiple runs, the drawer's per-card
    // X-button (`handleDismissRun` below) is the per-run path; this
    // function stays as the "blow everything away" reset for the
    // single-run UX surface (banner Dismiss + right-rail New run).
    const dismissedId = activeRun?.runId;
    setActiveRun(null);
    setRunData(null);
    setLogLines([]);
    setError(null);
    // Explicit clear in addition to the write-through effect — avoids a stale
    // read if the user immediately navigates away before the effect flushes.
    clearPersistedRun();
    if (dismissedId) {
      setActiveRuns(prev => {
        const next = new Map(prev);
        next.delete(dismissedId);
        return next;
      });
      setRunDataByRunId(prev => {
        const next = new Map(prev);
        next.delete(dismissedId);
        return next;
      });
      setLogLinesByRunId(prev => {
        const next = new Map(prev);
        next.delete(dismissedId);
        return next;
      });
    }
    setFocusedRunId(null);
  }

  // G9 — Per-card dismiss from the drawer X-button. Removes ONE run from
  // the parallel-runs Maps without touching the single-run state unless
  // the dismissed run happens to be the currently-focused one (in which
  // case we fall through to `handleReset` so the middle column flips
  // back to the config panel).
  //
  // Server-side: the run keeps executing. Dismiss is a view-only
  // detach — the user can re-attach via the Queue tab. Mirrors the
  // existing `handleReset` contract that backs the banner Dismiss
  // button.
  function handleDismissRun(runId) {
    if (!runId) return;
    if (runId === activeRun?.runId) {
      // Dismissing the focused run — fall through to full reset so the
      // single-run consumers (banners, right-rail stats) clear too.
      handleReset();
      return;
    }
    setActiveRuns(prev => {
      const next = new Map(prev);
      next.delete(runId);
      return next;
    });
    setRunDataByRunId(prev => {
      const next = new Map(prev);
      next.delete(runId);
      return next;
    });
    setLogLinesByRunId(prev => {
      const next = new Map(prev);
      next.delete(runId);
      return next;
    });
    if (focusedRunId === runId) {
      // Should be unreachable given the activeRun?.runId guard above,
      // but defence-in-depth — never leave focusedRunId pointing at a
      // dropped key.
      setFocusedRunId(null);
    }
  }

  // G9 — Drawer card click. Focus a run without launching anything.
  // When the focused run differs from the single-run `activeRun`, the
  // middle column would render the wrong run; for the migration we
  // mirror the focus into `activeRun` too. Once the single-run state
  // is deleted (next PR), this function only sets `focusedRunId`.
  function handleFocusRun(runId) {
    if (!runId) return;
    const entry = activeRuns.get(runId);
    if (!entry) return;
    setFocusedRunId(runId);
    setActiveRun(entry);
    const rd = runDataByRunId.get(runId);
    if (rd) setRunData(rd);
    const lines = logLinesByRunId.get(runId);
    if (Array.isArray(lines)) setLogLines(lines);
    setInnerTab("pipeline");
  }

  /**
   * G11 — Retry a failed/aborted run using the same configuration that
   * produced the original run. The backend persists `dialsConfig` inside
   * `run.generateInput` (see `backend/src/routes/runs.js:95` for crawl and
   * `backend/src/routes/tests.js:735` for generate), and `environmentId`
   * lives on the run row directly (`runRepo.js` INSERT_COLS), so a retry
   * is a stateless re-launch — no UI re-config required.
   *
   * Industry pattern: matches GitHub Actions' "Re-run failed jobs" and
   * Vercel's "Retry deployment" — the user expects the same inputs to
   * produce a fresh attempt without re-entering the form.
   *
   * Crawl runs reuse the project URL as the start page (no per-run URL
   * override exists); requirement runs reuse `generateInput.name` +
   * `generateInput.description` so the same prompt gets re-run.
   * Attachments are NOT preserved — they were folded into `description`
   * at launch time (`handleGenerateFromRequirement`), so retrying re-uses
   * the folded prompt verbatim. The user can edit + relaunch from the
   * config panel if they want a different prompt.
   */
  async function handleRetry() {
    if (!activeRun?.projectId || !runData) return;
    const runType = activeRun.type;
    if (runType !== "crawl" && runType !== "generate") {
      setError("Only crawl and generate runs can be retried.");
      return;
    }
    // Payload-shaping logic lives in `utils/runRetry.js` so this handler
    // stays focused on React side-effects (state writes + ensureAiProvider
    // pre-flight + SSE reconnect-race guard). See that module for the
    // legacy-run fallback contract.
    const { body } = buildRetryPayload(runData, dialsConfig);
    setError(null);
    if (!(await ensureAiProvider())) return;
    setLaunching(true);
    // Detach from the failed run BEFORE launching the new one. Same SSE
    // reconnect-race rationale as handleStartCrawl / handleGenerateFromRequirement.
    setActiveRun(null);
    setLogLines([]);
    setRunData(null);
    clearPersistedRun();
    try {
      if (runType === "crawl") {
        const { runId } = await api.crawl(activeRun.projectId, body);
        setActiveRun({ runId, projectId: activeRun.projectId, type: "crawl" });
      } else {
        // Generate retry — `name` + `description` come from the persisted
        // run via `resolveGenerateRetryFields` (defence-in-depth fallback
        // when `generateInput` is missing on legacy/interrupted rows).
        const { name, description } = resolveGenerateRetryFields(runData);
        const genBody = { ...body, name, description };
        const { runId } = await api.generateTest(activeRun.projectId, genBody);
        setActiveRun({ runId, projectId: activeRun.projectId, type: "generate" });
      }
      setInnerTab("pipeline");
    } catch (err) {
      setError(err.message || "Failed to retry run.");
    } finally {
      setLaunching(false);
    }
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
    const entry = { runId: run.id, projectId: run.projectId, type: run.type };
    setActiveRun(entry);
    // Seed runData with whatever we already have cached — SSE's first
    // `snapshot` event will overwrite with the authoritative server copy.
    setRunData({ ...run, status: run.status });
    setLogLines([]);
    setInnerTab("pipeline");
    setError(null);
    // G9 — register the attached run in the parallel Maps + focus it.
    // Seeds runData per-runId from the cached row so the drawer card
    // renders subtitle + tone immediately even before SSE connects.
    setActiveRuns(prev => {
      const next = new Map(prev);
      next.set(run.id, entry);
      return next;
    });
    setRunDataByRunId(prev => {
      const next = new Map(prev);
      next.set(run.id, { ...run, status: run.status });
      return next;
    });
    setLogLinesByRunId(prev => {
      const next = new Map(prev);
      next.set(run.id, []);
      return next;
    });
    setFocusedRunId(run.id);
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
    // G10 — the live run view no longer follows the project selector.
    // Before this fix, switching projects called `handleReset()`, which
    // tore down the SSE connection + cleared `runData` / `logLines` /
    // `activeRun`. The run kept executing server-side but the user lost
    // all visibility into it from the page they were on — the only
    // recovery was clicking through the Queue tab. That broke the
    // legitimate workflow of "kick off a long crawl, then browse other
    // projects' tests while it runs."
    //
    // The fix: keep `activeRun` + `runData` + `logLines` + the SSE
    // connection intact when `selectedId` changes. The middle column's
    // attached-run view (`activeRun ? <run-center> : <config>`) stays
    // visible because `activeRun` is unchanged; the run-center label
    // shows the ORIGINAL project's name (resolved via
    // `runProjectForLabel` below) rather than the newly-selected one,
    // so the user can see "MYPROJ-A · LINK CRAWL" while the sidebar
    // highlights MYPROJ-B and the right rail shows MYPROJ-B's config.
    //
    // Mental model: project sidebar = "which project's config am I
    // looking at" (cheap, frequent). Run view = "which run am I
    // monitoring" (expensive, sticky). Decoupling the two lets the
    // user do both at once without losing either context.
    //
    // The right rail's "Active runs" list already provided a re-attach
    // path via `handleAttachRun`, but it only listed running runs and
    // discarded view state on every switch — keeping the live view
    // pinned is strictly better for the operator-flow case.
    setSelectedId(nextProjectId);
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

  // ── Split generated-test outcomes (drafts vs auto-approved) ────────────
  // The run payload reports `testsGenerated` as a single count and the SSE
  // `done` event only carries that total — it has no per-outcome breakdown.
  // Without splitting, the completion banner labels every test a "draft"
  // even when the project's auto-approval threshold cleared some of them,
  // contradicting what the user sees the moment they land in Review Queue.
  //
  // `runData.tests` is the canonical array of test IDs persisted on the run
  // row (see `backend/src/database/repositories/runRepo.js#INSERT_COLS`),
  // and `allTests` (from `useProjectData`) already carries the authoritative
  // `reviewStatus` + `approvalSource` columns refreshed by the
  // `invalidateProjectDataCache()` we fire on the SSE done event. So the
  // split is a pure client-side derivation against data we already have.
  const generatedOutcome = useMemo(() => {
    const total = runData?.testsGenerated ?? 0;
    const ids = Array.isArray(runData?.tests) ? runData.tests : [];
    if (!ids.length || !allTests.length) {
      // Fall back to the legacy "treat as drafts" shape until the tests
      // cache refreshes — this matches pre-fix behaviour and avoids
      // flashing "0 drafts" while the refetch is in flight.
      return { total, drafts: total, autoApproved: 0 };
    }
    const idSet = new Set(ids);
    let drafts = 0;
    let autoApproved = 0;
    for (const t of allTests) {
      if (!idSet.has(t.id)) continue;
      if (t.reviewStatus === "approved" && t.approvalSource === "auto") autoApproved++;
      else if (!t.reviewStatus || t.reviewStatus === "draft") drafts++;
    }
    return { total, drafts, autoApproved };
  }, [runData?.testsGenerated, runData?.tests, allTests]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="tl-wrap">

      {/* ── Tab bar ── */}
      <div className="tl-topbar">
        <div className="tl-topbar__brand">
          <Atom size={16} className="tl-topbar__brand-icon" />
          <span className="tl-topbar__brand-title">Test Lab</span>
          <span className="tl-topbar__brand-tagline">AI test generation workspace</span>
        </div>

        {/* G15 (a11y) — WAI-ARIA APG tablist. Implementation + comments
            live in `frontend/src/components/test-lab/TestLabTabs.jsx`. */}
        <TestLabTabs
          tab={tab}
          onChange={setTab}
          activeQueueCount={activeQueueRuns.length}
        />

        {/* Record action — right-aligned, styled as a primary CTA so it
            reads as a peer to the tabs rather than disappearing as a ghost
            button. Recording remains a modal because the live screencast
            preview needs a focused overlay surface; the Test Lab page only
            provides the launch point. Disabled until a project is selected
            so we have a valid `projectId` to seed. */}
        <button
          className="btn btn-primary btn-sm tl-record-btn"
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
              <h2 className="page-title tl-queue-title">Queue</h2>
              <p className="page-subtitle">All active and recent generation runs across projects</p>
            </div>
            <div className="flex-between gap-sm tl-queue-actions">
              <span className="badge badge-blue">{activeQueueRuns.length} active</span>
              {activeQueueRuns.length > 0 && (
                <span className="badge badge-green tl-queue-pulse-badge">running</span>
              )}
              {/* Project filter — shown when there are multiple projects */}
              {projects.length > 1 && (
                <select
                  className="tl-select tl-queue-filter-select"
                  value={queueFilter}
                  onChange={e => setQueueFilter(e.target.value)}
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
                  // ONB-002 (audit): swap the bare emoji+text empty state for
                  // the shared primitive so the Queue tab matches the icon +
                  // title + description + CTA shape used on Tests, Projects,
                  // Runs, HealingDashboard, and Dashboard. The CTA jumps the
                  // user back to the Crawl & Generate tab — the action that
                  // produces queue rows — instead of leaving them stuck on an
                  // empty surface. When a project filter is active, we also
                  // surface a "Clear filter" secondary action so the user has
                  // an escape hatch without retyping the dropdown.
                  <EmptyState
                    icon={<Clock size={32} color="var(--accent)" />}
                    title={queueFilter === "all" ? "No runs yet" : "No runs for this project"}
                    description={queueFilter === "all"
                      ? "Start a crawl or generate tests from a requirement to see them here."
                      : "Switch to a different project or start a new run."}
                    secondaryAction={queueFilter !== "all"
                      ? { label: "Clear filter", onClick: () => setQueueFilter("all") }
                      : null}
                    action={{ label: "Start Crawl & Generate", onClick: () => setTab("crawl") }}
                  />
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
                    <div className="section-label mb-sm tl-queue-recent-label">Recent</div>
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
      {/* G9 — parallel-runs drawer. Renders a bottom-anchored strip of
          cards, one per active run. Clicking a card focuses that run in
          the middle column. X-button dismisses (detaches SSE, removes
          from Maps). Hidden when no runs are attached. */}
      <RunDrawer
        activeRuns={activeRuns}
        runDataByRunId={runDataByRunId}
        focusedRunId={focusedRunId}
        projects={projects}
        onFocus={handleFocusRun}
        onDismiss={handleDismissRun}
      />

      {showRecorder && selectedProject && (
        <RecorderModal
          open={showRecorder}
          onClose={() => setShowRecorder(false)}
          projectId={selectedProject.id}
          projects={projects}
          defaultUrl={selectedProject.url || ""}
          // DIF-012: forward the page-level env selection so the recorder
          // opens on the selected environment without the operator having
          // to re-pick. The modal re-loads its own env list internally so
          // switching projects inside the modal stays correct.
          defaultEnvironmentId={environmentId || ""}
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
          {/* G15 (a11y) — sidebar wrapped as `role="navigation"` with an
              `aria-label` so screen readers announce "Projects navigation"
              when the user tabs into the rail. Inner list uses semantic
              defaults (the per-item `role="button"` already gives screen
              readers the actionable shape); a literal `role="listbox"`
              would imply single-select with arrow-key navigation, which
              we don't yet implement and would mislead AT users. Revisit
              this once arrow-key list nav lands. */}
          <nav className="tl-projects" aria-label="Projects">
            <div className="tl-col-header" id="tl-projects-heading">Projects</div>
            <div className="tl-proj-list" aria-labelledby="tl-projects-heading">
              {loadingProjects
                ? [1, 2].map(i => (
                    <div key={i} className="skeleton tl-proj-skeleton" />
                  ))
                : projects.map(p => (
                    // G15 (a11y) — project sidebar items were `<div onClick>`
                    // with no keyboard affordance. WCAG 2.1.1 (Keyboard, Level
                    // A) requires every interactive element be operable via
                    // keyboard. Promoted to `role="button"` + `tabIndex={0}`
                    // + Enter/Space activation. `aria-pressed` reflects the
                    // selected state so screen-reader users hear "selected"
                    // / "not selected" alongside the visible active styling.
                    // Kept as a `<div>` (not a `<button>`) because the inner
                    // markup is two block-level rows (name + url) and a
                    // native `<button>` requires `display: flex` overrides
                    // that fight with the existing `.tl-proj-item` flex rule.
                    <div
                      key={p.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={p.id === selectedId}
                      aria-label={`Select project ${p.name}`}
                      className={`tl-proj-item${p.id === selectedId ? " tl-proj-item--active" : ""}`}
                      onClick={() => handleSelectProject(p.id)}
                      onKeyDown={(e) => {
                        // Enter + Space activate, matching native <button>
                        // behaviour. preventDefault on Space stops the page
                        // scroll. Other keys pass through (Tab navigates,
                        // arrow keys reserved for future list-nav follow-up).
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleSelectProject(p.id);
                        }
                      }}
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
                <div className="tl-proj-meta-value tl-proj-meta-value--row2">
                  {lastCrawlRun.pagesFound ?? "?"} pages · {lastCrawlRun.testsGenerated ?? "?"} tests
                </div>
              </div>
            )}
          </nav>

          {/* ── Middle: Configuration / Running / Completed view ── */}
          {/* Show the run view (pipeline / sitegraph / logs) whenever a run is
              attached — running, completed, or failed. The user dismisses
              explicitly via the banner buttons below; without this, completed
              crawls would snap back to the config panel and the pipeline +
              site graph would vanish. */}
          {activeRun ? (
            // ── Attached run: pipeline + site graph + live log ──
            <div className="tl-run-center">
              {/* G10 — the run-center label shows the RUN's project, not
                  the sidebar's `selectedProject`. After the project-
                  switch decoupling above, those can diverge: the user
                  starts a crawl on MYPROJ-A, then clicks MYPROJ-B in
                  the sidebar to browse its tests. The middle column
                  must still show "MYPROJ-A · LINK CRAWL" because that's
                  the run we're monitoring. Resolved by id from the
                  shared `projects` cache (`useProjectData`) — falls
                  back to the bare project id when the cache hasn't
                  populated yet (rare; defence-in-depth). */}
              <div className="tl-run-label">
                {(projects.find(p => p.id === activeRun.projectId)?.name
                  || activeRun.projectId
                  || "—").toUpperCase()} · {activeRun?.type === "crawl" ? "LINK CRAWL" : "REQUIREMENT"}
                {isRunDone && <span className="tl-run-status-suffix tl-run-status-suffix--done">· COMPLETED</span>}
                {isRunFailed && (
                  <span className="tl-run-status-suffix tl-run-status-suffix--failed">
                    · {runStatus === "aborted" ? "ABORTED" : "FAILED"}
                  </span>
                )}
              </div>

              {/* SSE reconnection / polling-fallback banners — only shown
                  while the run is actively running. Mirrors RunDetail.jsx so
                  users get the same feedback wherever they monitor a run. */}
              {isRunActive && retryIn != null && !sseDown && (
                <div className="banner banner-info tl-banner-row">
                  <RefreshCw size={13} className="tl-banner-row__icon" />
                  <span>Connection lost — reconnecting in {retryIn}s…</span>
                </div>
              )}
              {isRunActive && sseDown && (
                <div className="banner banner-warning tl-banner-row">
                  <RefreshCw size={13} className="spin tl-banner-row__icon" />
                  <span>Live updates unavailable — refreshing every 5s.</span>
                </div>
              )}

              {/* Terminal banners — rendered at the top of the run view so the
                  pipeline / logs stay visible underneath for review. */}
              {isRunDone && (
                <div className="banner banner-success tl-banner-margin">
                  <CheckCircle2 size={16} />
                  <div className="tl-banner-body">
                    <strong>Generation complete</strong> — {generatedOutcome.total} test{generatedOutcome.total !== 1 ? "s" : ""} generated
                    {generatedOutcome.autoApproved > 0 && (
                      <> · <span className="text-green">{generatedOutcome.autoApproved} auto-approved</span></>
                    )}
                    {generatedOutcome.drafts > 0 && (
                      <> · {generatedOutcome.drafts} awaiting review</>
                    )}
                    .
                    <div className="tl-banner-actions">
                      {generatedOutcome.drafts > 0 && (
                        <button
                          className="btn btn-primary btn-xs"
                          onClick={() => navigate(`/review-queue?projectId=${activeRun.projectId}`)}
                        >
                          Review {generatedOutcome.drafts} draft{generatedOutcome.drafts !== 1 ? "s" : ""} <ChevronRight size={12} />
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
                <div className="banner banner-error tl-banner-margin">
                  <div>
                    <strong>{runStatus === "aborted" ? "Run aborted" : "Run failed"}</strong>
                    {runData?.error ? ` — ${runData.error}` : "."}
                    {/* G11 — Retry uses the same dialsConfig + environmentId
                        from the failed run. Implementation in `RetryButton`;
                        `launching` is shared with the page's other launch
                        handlers so a concurrent crawl/generate also disables
                        retry. */}
                    <RetryButton
                      onRetry={handleRetry}
                      launching={launching}
                      size="sm"
                      className="tl-banner-spaced-btn-l"
                    />
                    <button
                      className="btn btn-ghost btn-xs tl-banner-spaced-btn-s"
                      onClick={() => navigate(`/runs/${activeRun.runId}`)}
                    >
                      View run <ChevronRight size={12} />
                    </button>
                    <button
                      className="btn btn-ghost btn-xs tl-banner-spaced-btn-s"
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
                // "logs" tab kept for crawl runs only — the narrative feed is
                // the primary view; raw log is accessible via the Logs tab for
                // debugging. Requirement runs don't crawl so no sitegraph.
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
                          <div className="progress-bar tl-pipeline-progress-bar">
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

                        {/* Sub-col 2: multi-agent chat transcript.
                            Task 3 — replaces NarrativeFeed (single narrator)
                            with `<AgentConversation>` (chat transcript with
                            per-agent avatars + handoff turns). Reads from the
                            same `runData` shape; no SSE wiring changes.
                            Backend Task 2 `agent_event` SSE stream will swap
                            the client-side synthesizer for real events in a
                            follow-up PR. */}
                        <div className="tl-pipeline-log-col">
                          <div className="tl-pipeline-col-label">Agents talking</div>
                          <AgentConversation
                            run={runData}
                            isRunActive={isRunActive}
                            allTests={allTests}
                          />
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
                              <div className="tl-run-stat-val tl-pipeline-stat-val--default">
                                {ps.pagesFound ?? runData?.pagesFound ?? 0}
                              </div>
                              <div className="tl-run-stat-lbl">Pages crawled</div>
                            </div>
                          </div>

                          {isRunActive ? (
                            <button
                              className="btn btn-ghost tl-pipeline-stat-btn"
                              onClick={handleStop}
                              disabled={stopLoading}
                            >
                              <StopCircle size={15} />
                              {stopLoading ? "Stopping…" : "Stop run"}
                            </button>
                          ) : !isRunDone && !isRunFailed ? null : (
                            <button
                              className="btn btn-ghost tl-pipeline-stat-btn"
                              onClick={handleReset}
                            >
                              New run
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {innerTab === "sitegraph" && isCrawl && (
                      <div className="tl-sitegraph-pane">
                        <SiteGraph
                          pages={graphPages}
                          activePage={activePage}
                          isRunning={isRunActive}
                        />
                      </div>
                    )}

                    {innerTab === "logs" && (
                      <div className="tl-logs-pane">
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
                        <span className="tl-section-label-hint">
                          (optional — auto-derived from the requirement if blank)
                        </span>
                      </div>
                      <input
                        className="tl-select tl-name-input"
                        type="text"
                        value={testName}
                        onChange={e => setTestName(e.target.value)}
                        placeholder="e.g. Dashboard loads all employee charts"
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
                          <div className="tl-import-issue-label">
                            Paste a Jira issue (title on first line, description below)
                          </div>
                          <textarea
                            className="tl-req-area tl-import-issue-textarea"
                            value={importIssueText}
                            onChange={e => setImportIssueText(e.target.value)}
                            placeholder={"PROJ-123 Login fails for SSO users\nAs a user with SSO enabled I expect to be redirected to the IdP…"}
                            rows={4}
                            autoFocus
                          />
                          <div className="tl-import-issue-actions">
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
                            className="tl-file-input-hidden"
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
                  <div className="tl-stat-cell tl-stat-cell--header">
                    <div className="tl-stat-cell__title">
                      {selectedProject?.name ?? "—"}
                    </div>
                    <div className="tl-stat-cell__sub">
                      {activeRun?.type === "crawl" ? "Crawl & Generate" : "From Requirement"}
                    </div>
                  </div>

                  {/* Final test count — shown when done */}
                  {(isRunDone || isRunFailed) && (
                    <div className="tl-run-stats tl-run-stats--final">
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
                      className="btn btn-ghost tl-full-btn"
                      onClick={handleStop}
                      disabled={stopLoading}
                    >
                      <StopCircle size={15} />
                      {stopLoading ? "Stopping…" : "Stop run"}
                    </button>
                  ) : (
                    <div className="tl-btn-stack">
                      {isRunDone && generatedOutcome.drafts > 0 && (
                        <button
                          className="btn btn-primary tl-full-btn"
                          onClick={() => navigate(`/review-queue?projectId=${activeRun.projectId}`)}
                        >
                          Review {generatedOutcome.drafts} draft{generatedOutcome.drafts !== 1 ? "s" : ""} <ChevronRight size={13} />
                        </button>
                      )}
                      {isRunDone && generatedOutcome.drafts === 0 && generatedOutcome.autoApproved > 0 && (
                        <button
                          className="btn btn-primary tl-full-btn"
                          onClick={() => navigate(`/projects/${activeRun.projectId}?tab=tests`)}
                        >
                          View {generatedOutcome.autoApproved} auto-approved <ChevronRight size={13} />
                        </button>
                      )}
                      {/* G11 — Retry shows on failed/aborted runs (not on
                          completed runs — there's nothing to retry when the
                          pipeline succeeded). Same handler the banner uses;
                          the panel button is a redundant entry point for
                          users who've scrolled past the top-of-page banner. */}
                      {isRunFailed && (
                        <button
                          className="btn btn-primary tl-full-btn"
                          onClick={handleRetry}
                          disabled={launching}
                          title="Re-run with the same configuration"
                        >
                          {launching ? (
                            <><span className="spin"><RotateCcw size={13} /></span> Retrying…</>
                          ) : (
                            <><RotateCcw size={13} /> Retry run</>
                          )}
                        </button>
                      )}
                      <button
                        className="btn btn-ghost tl-full-btn"
                        onClick={() => navigate(`/runs/${activeRun.runId}`)}
                      >
                        View run detail <ChevronRight size={13} />
                      </button>
                      <button
                        className="btn btn-ghost tl-full-btn"
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
                            {pagesFound != null ? pagesFound : <span className="tl-stat-placeholder">—</span>}
                          </div>
                          <div className="tl-stat-lbl">Pages found</div>
                        </div>
                        <div className="tl-stat-cell">
                          <div className="tl-stat-val">
                            {existingTests != null ? existingTests : <span className="tl-stat-placeholder">—</span>}
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
                            {existingTests != null ? existingTests : <span className="tl-stat-placeholder">—</span>}
                          </div>
                          <div className="tl-stat-lbl">Existing tests</div>
                        </div>
                        <div className="tl-stat-cell">
                          <div className="tl-stat-val tl-stat-val--text">
                            {requirement.trim() ? "Ready" : <span className="tl-stat-placeholder">—</span>}
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

                  {/* DIF-012: environment selector — only renders when the
                      selected project has ≥ 1 environment. Same shape as the
                      RunRegressionModal dropdown so the run/crawl/generate
                      UX stays uniform. Styles live in `pages/test-lab.css`
                      under `.tl-env-*` to keep this JSX inline-style free. */}
                  {environments.length > 0 && (
                    <div className="tl-env-section">
                      <div className="tl-panel-section-label">Environment</div>
                      <select
                        className="tl-select tl-env-select"
                        value={environmentId}
                        onChange={(e) => setEnvironmentId(e.target.value)}
                      >
                        <option value="">Default (project URL)</option>
                        {environments.map((env) => (
                          <option key={env.id} value={env.id}>{env.name} — {env.baseUrl}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* CTA */}
                  {!selectedProject && (
                    <div className="banner banner-warning mb-md">
                      Select a project to continue.
                    </div>
                  )}

                  {tab === "crawl" && (
                    <button
                      className="btn btn-primary tl-full-btn--padded"
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
                      className="btn btn-primary tl-full-btn--padded"
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
                          className="tl-active-run-card tl-active-run-card-btn mb-sm"
                          onClick={() => handleAttachRun(run)}
                          title="View live pipeline for this run"
                        >
                          <div className="tl-arc-header">
                            <ProjIcon project={proj} />
                            <span className="tl-arc-name">{proj?.name ?? "—"}</span>
                            <span className="badge badge-blue tl-arc-live-badge">live</span>
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