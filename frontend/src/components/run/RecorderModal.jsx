import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api.js";
import { API_PATH } from "../../utils/apiBase.js";
import { useSseStream } from "../../hooks/useSseStream.js";
import { actionToStepText, actionRawLocator } from "../../utils/actionToStepText.js";
import LiveBrowserView from "./LiveBrowserView.jsx";

// A11Y-002 (audit follow-up) — focus trap for the full-screen recorder stage.
// RecorderModal uses createPortal directly with a custom canvas + sidebar
// layout rather than wrapping in ModalShell — refactoring to ModalShell
// would conflict with the live-browser canvas and nested confirm dialogs
// (Cypress Studio / Playwright Codegen / Selenium IDE follow the same
// pattern). The trap is applied in-place, mirroring `pages/Login.jsx:167`
// which made the same architectural call for the same reason (nested MFA
// overlay). WCAG 2.1.2 satisfied at the stage root.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// DIF-015c Gap 5 — curated device presets. Mirrors DEVICE_PRESETS in
// backend/src/runner/config.js and the identical list in
// RunRegressionModal.jsx. Kept as a static list to avoid an extra API
// call on every modal open; if you add a device server-side, mirror it
// here AND in RunRegressionModal.
const DEVICE_PRESETS = [
  { label: "Desktop (default)", value: "" },
  { label: "iPhone 14", value: "iPhone 14" },
  { label: "iPhone 14 Pro Max", value: "iPhone 14 Pro Max" },
  { label: "iPhone 12", value: "iPhone 12" },
  { label: "iPad (gen 7)", value: "iPad (gen 7)" },
  { label: "iPad Pro 11", value: "iPad Pro 11" },
  { label: "Galaxy S9+", value: "Galaxy S9+" },
  { label: "Pixel 7", value: "Pixel 7" },
  { label: "Pixel 5", value: "Pixel 5" },
  { label: "Galaxy Tab S4", value: "Galaxy Tab S4" },
  { label: "Desktop Chrome HiDPI", value: "Desktop Chrome HiDPI" },
  { label: "Desktop Firefox HiDPI", value: "Desktop Firefox HiDPI" },
];

export default function RecorderModal({ open, onClose, onSaved, projectId, defaultUrl = "", projects = null, defaultEnvironmentId = "" }) {
  const [phase, setPhase] = useState("idle");
  // Selected project — initialised from the `projectId` prop but mutable in the
  // idle form so the user can route the recording to any project they belong
  // to (without this, the "Record a test" quick action on /tests always saved
  // into projects[0] regardless of which project the user actually wanted).
  // When `projects` is null or has ≤ 1 entry the picker is hidden — the modal
  // is already project-scoped (e.g. opened from ProjectDetail).
  const [selectedProjectId, setSelectedProjectId] = useState(projectId);
  const [startUrl, setStartUrl] = useState(defaultUrl);
  const [sessionId, setSessionId] = useState(null);
  const [actions, setActions] = useState([]);
  const [frames, setFrames] = useState([]);
  const [name, setName] = useState("");
  // resolvedIndices: Set of action indices that have transitioned from the
  // brief "raw locator" phase to the human-readable label phase. flashIndices
  // tracks which of those should currently show the yellow highlight.
  const [resolvedIndices, setResolvedIndices] = useState(new Set());
  const [flashIndices, setFlashIndices] = useState(new Set());
  const resolveTimersRef = useRef(new Map()); // index → timeoutId
  const [assertKind, setAssertKind] = useState("assertVisible");
  const [assertSelector, setAssertSelector] = useState("");
  const [assertValue, setAssertValue] = useState("");
  const [assertLabel, setAssertLabel] = useState("");
  const [error, setError] = useState(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [shortcutArmed, setShortcutArmed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  // DIF-015c Gap 5 — selected device profile. Mirrors `RunRegressionModal`'s
  // dropdown so operators get the same options across run + record flows.
  // Empty string = desktop default. `pendingDeviceSwitch` gates the
  // mid-session confirmation dialog described in NEXT.md `:53`.
  const [device, setDevice] = useState("");
  const [pendingDeviceSwitch, setPendingDeviceSwitch] = useState(null);
  const [deviceSwitching, setDeviceSwitching] = useState(false);
  // DIF-015c Gap 6 — opt-in stealth profile. The toggle lives in the
  // idle launch form (post-launch the flag is immutable because the
  // stealth init script is registered before the first navigation, and
  // changing it would require a context rebuild that defeats the point
  // — operators who change their mind discard and re-launch).
  const [stealth, setStealth] = useState(false);
  // DIF-015c Gap 2 (point-and-click assert UX) — assert mode state.
  // When `assertMode` is true the canvas suppresses input forwarding and
  // instead shows a hover-driven highlight overlay; clicking commits the
  // pick by pre-filling the verification form with `{selector, label}`
  // from the most recent probe. `currentProbe` holds the latest
  // `{selector, label}` so a click can fire even if the user happens to
  // click before a fresh hover probe has settled.
  const [assertMode, setAssertMode] = useState(false);
  const [highlightRect, setHighlightRect] = useState(null);
  const currentProbeRef = useRef(null);
  const probeTimerRef = useRef(null);
  // Candidate URLs surfaced as a datalist suggestion list under the Starting
  // URL input — seed URL + any pages discovered on the latest successful
  // crawl. Fetched lazily when the modal opens so projects without a crawl
  // simply see the seed URL and an empty suggestion list.
  const [urlOptions, setUrlOptions] = useState([]);
  // DIF-012: per-project environments — populated lazily on project change.
  // `environmentId === ""` means "default — use project.url"; the recordStart
  // body omits the field entirely in that case.
  const [environments, setEnvironments] = useState([]);
  const [environmentId, setEnvironmentId] = useState(defaultEnvironmentId);
  const pollRef = useRef(null);
  const sessionIdRef = useRef(null);
  const projectIdRef = useRef(projectId);
  const lastMoveRef = useRef(0);
  // A11Y-002 (audit follow-up) — refs for the focus trap. `stageRef` scopes
  // the focusable query to the recorder stage; `lastFocusedRef` remembers
  // what the user was on before launch so we can restore on close.
  const stageRef = useRef(null);
  const lastFocusedRef = useRef(null);

  const handleInput = useCallback((event) => {
    const sid = sessionIdRef.current;
    const pid = projectIdRef.current;
    if (!sid || !pid) return;
    if (event.type === "mouseMoved") {
      const now = Date.now();
      if (now - lastMoveRef.current < 33) return;
      lastMoveRef.current = now;
    }
    api.recordInput(pid, sid, event).catch(() => {});
  }, []);

  useEffect(() => { setStartUrl(defaultUrl); }, [defaultUrl]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  // Mirror the *active* selection into the ref so handleInput() / cleanup
  // hooks always target the project the recording was launched against,
  // even if the parent's `projectId` prop has since changed.
  useEffect(() => { projectIdRef.current = selectedProjectId; }, [selectedProjectId]);
  // When the parent prop changes (e.g. modal re-opened for a different
  // project), reset the local selection to match.
  useEffect(() => { setSelectedProjectId(projectId); }, [projectId]);

  // Auto-fill the Starting URL with the selected project's seed URL whenever
  // the user picks a different project in the idle form (only while idle —
  // never overwrite a URL the user has already started recording against).
  useEffect(() => {
    if (phase !== "idle" && phase !== "error") return;
    if (!Array.isArray(projects)) return;
    const proj = projects.find((p) => p.id === selectedProjectId);
    if (proj?.url) setStartUrl(proj.url);
  }, [selectedProjectId, projects, phase]);

  // Populate the Starting URL datalist with the project's seed URL + pages
  // discovered on the latest successful crawl. Best-effort — failures fall
  // through to an empty suggestion list rather than blocking the recorder.
  useEffect(() => {
    if (!open || !selectedProjectId) return;
    let cancelled = false;
    api.getProjectPages(selectedProjectId)
      .then((res) => { if (!cancelled) setUrlOptions(res?.urls || []); })
      .catch(() => { if (!cancelled) setUrlOptions([]); });
    return () => { cancelled = true; };
  }, [open, selectedProjectId]);

  // DIF-012: load environments whenever the modal is open and the project
  // changes. Viewers get a 403 on the env-list endpoint — swallow that so
  // the modal still works for users below qa_lead (the dropdown just stays
  // hidden because the list is empty).
  useEffect(() => {
    if (!open || !selectedProjectId) { setEnvironments([]); setEnvironmentId(""); return; }
    let cancelled = false;
    // Reset to the caller-supplied default whenever the project changes so a
    // stale envId from a previous project never leaks into the recordStart
    // payload (backend would 400 on cross-project envId anyway).
    setEnvironmentId(defaultEnvironmentId || "");
    api.getProjectEnvironments(selectedProjectId)
      .then((rows) => { if (!cancelled) setEnvironments(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setEnvironments([]); });
    return () => { cancelled = true; };
  }, [open, selectedProjectId, defaultEnvironmentId]);

  // DIF-012: auto-fill Starting URL with the selected environment's baseUrl
  // (only while idle, only when an env is picked). Mirrors the existing
  // project.url auto-fill above — the env baseUrl takes precedence so the
  // operator lands on the right environment from the first frame.
  useEffect(() => {
    if (phase !== "idle" && phase !== "error") return;
    if (!environmentId) return;
    const env = environments.find((e) => e.id === environmentId);
    if (env?.baseUrl) setStartUrl(env.baseUrl);
  }, [environmentId, environments, phase]);

  const sseUrl = sessionId ? `${API_PATH}/runs/${sessionId}/events` : null;
  useSseStream(sseUrl, useCallback((event) => {
    if (event?.type === "frame" && event.data) setFrames([event.data]);
  }, []), Boolean(sessionId));

  useEffect(() => {
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      // Cancel any pending raw→resolved / flash-removal timers so they don't
      // fire setResolvedIndices / setFlashIndices after the component has
      // unmounted (e.g. user navigates away mid-recording). teardownStreams()
      // clears the same map on stop/discard, but that path isn't taken when
      // the parent unmounts us directly.
      for (const t of resolveTimersRef.current.values()) clearTimeout(t);
      resolveTimersRef.current.clear();
      // DIF-015c Gap 2 — drop the in-flight probe timer too so the
      // debounced setTimeout doesn't fire after unmount and try to
      // setState on a dead component.
      if (probeTimerRef.current) { clearTimeout(probeTimerRef.current); probeTimerRef.current = null; }
      if (sessionIdRef.current && projectIdRef.current) {
        api.recordDiscard(projectIdRef.current, sessionIdRef.current).catch(() => {});
        sessionIdRef.current = null;
      }
    };
  }, []);

  // A11Y-002 (audit follow-up) — Focus trap for the full-screen recorder
  // stage. Same shape as `ModalShell` and `pages/Login.jsx:169-211`:
  //   1. On open, remember the previously-focused element and move focus
  //      into the stage so screen readers land on something actionable.
  //   2. Tab / Shift+Tab wrap around the focusable set inside the stage,
  //      re-queried on every Tab press to pick up phase-driven enables
  //      (e.g. the "Stop & save" button becoming clickable once the user
  //      captures their first action).
  //   3. On close, restore focus to whatever launched the recorder.
  //
  // Intentionally NOT trapped: the LiveBrowserView canvas itself. The
  // canvas needs to receive arbitrary keyboard input to forward to the
  // SUT (form fills, shortcuts, etc.), so Tab inside the canvas should
  // forward to the page being recorded — not cycle through the sidebar.
  // The canvas has `tabindex="-1"` so it never enters the focus cycle;
  // operators reach it via mouse, and once focused, keyboard events
  // forward to the recorded session.
  useEffect(() => {
    if (!open) return;
    lastFocusedRef.current = document.activeElement;

    // Move focus into the stage on mount. Pick the first focusable so
    // screen readers announce the first input (typically the Project
    // picker or Starting URL field on idle, or "Pause capture" once
    // recording). Fall back to the stage container with a synthetic
    // tabindex if no focusable child exists (shouldn't happen — there's
    // always at least the Exit button — but defensive).
    const stage = stageRef.current;
    if (stage) {
      const focusables = stage.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusables.length > 0) {
        // Skip the canvas itself (tabindex="-1") and any element that's
        // disabled mid-transition — go straight to the first interactive
        // control in the form / sidebar.
        focusables[0].focus();
      } else {
        stage.setAttribute("tabindex", "-1");
        stage.focus();
      }
    }

    function onKey(e) {
      // Escape is handled by `handleCancel` via the Exit button — we
      // don't intercept it here because the existing button-driven flow
      // already handles the recording-in-progress confirm prompt, which
      // is more nuanced than a raw close.
      if (e.key !== "Tab") return;

      // A11Y-002 follow-up: when a nested sub-dialog is open (discard
      // confirm, device-switch confirm), scope the focus cycle to that
      // sub-dialog instead of the whole stage. The sub-dialogs are
      // siblings inside `stageRef` rather than portaled overlays, so a
      // naive whole-stage Tab walk would otherwise step through every
      // disabled sidebar button behind the open dialog before reaching
      // Cancel / Discard — the user perceives the trap as broken.
      //
      // Detection key: any descendant `[role="dialog"][aria-modal="true"]`
      // that isn't the stage root itself. The two `.recorder-confirm`
      // blocks below carry these attributes for exactly this purpose.
      // When multiple sub-dialogs are open (shouldn't happen — they
      // gate each other in state, but defence-in-depth), pick the LAST
      // one in DOM order as the topmost.
      const stage = stageRef.current;
      if (!stage) return;
      const subDialogs = stage.querySelectorAll(
        '[role="dialog"][aria-modal="true"]'
      );
      // Filter out the stage itself (also marked role="dialog") so we
      // only scope when a TRUE sub-dialog is open.
      const innerDialogs = Array.from(subDialogs).filter((d) => d !== stage);
      const scope = innerDialogs.length > 0
        ? innerDialogs[innerDialogs.length - 1]
        : stage;

      const focusables = scope.querySelectorAll(FOCUSABLE_SELECTOR);
      if (!focusables || focusables.length === 0) {
        e.preventDefault();
        scope.focus?.();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inScope = scope.contains(active);
      if (!inScope) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Restore focus on close. Wrapped in try/catch since the trigger
      // node may have been unmounted (e.g. user clicked "Record" on a
      // row that gets removed from the page mid-recording).
      try { lastFocusedRef.current?.focus?.(); } catch { /* node gone */ }
    };
  }, [open]);

  async function handleStart() {
    setError(null); setActions([]); setFrames([]);
    if (!selectedProjectId) {
      setError("Select a project to record into."); return;
    }
    if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
      setError("Enter a valid http(s) URL to record from."); return;
    }
    const stale = sessionIdRef.current;
    if (stale) {
      // Await discard so the previous browser is fully torn down before we
      // launch a new one. Fire-and-forget here let the new screencast race
      // the old session's Chromium close, producing black-canvas symptoms.
      try { await api.recordDiscard(projectIdRef.current || selectedProjectId, stale); }
      catch { /* best-effort */ }
      sessionIdRef.current = null; setSessionId(null);
    }
    teardownStreams();
    setPhase("starting");
    try {
      // DIF-012: only forward environmentId when set — sending "" makes the
      // backend run an extra lookup before falling back to project.url.
      const startBody = { startUrl };
      if (environmentId) startBody.environmentId = environmentId;
      // DIF-015c Gap 5: only send device when the operator picked a
      // non-default option, so the backend's allowlist check doesn't
      // fire on the desktop-default path.
      if (device) startBody.device = device;
      // DIF-015c Gap 6: only send stealth: true when the operator
      // explicitly opted in. The backend coerces to strict-true so a
      // missing field is identical to false, but skipping the field
      // entirely keeps the request body minimal on the common path.
      if (stealth === true) startBody.stealth = true;
      const { sessionId: sid, viewport: vp, device: serverDevice, stealth: serverStealth } =
        await api.recordStart(selectedProjectId, startBody);
      setSessionId(sid);
      setPaused(false);
      if (typeof serverDevice === "string") setDevice(serverDevice);
      if (typeof serverStealth === "boolean") setStealth(serverStealth);
      if (vp && vp.width > 0 && vp.height > 0) setViewport({ width: vp.width, height: vp.height });
      setPhase("recording");
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.recordStatus(selectedProjectId, sid);
          const incoming = status.actions || [];
          setActions((prev) => {
            const prevLen = prev.length;
            if (incoming.length > prevLen) {
              // Schedule raw→resolved transitions for every newly arrived step.
              // Each step shows as a dim italic raw locator for 600 ms, then
              // flips to human-readable prose with a yellow highlight flash.
              for (let i = prevLen; i < incoming.length; i++) {
                const idx = i;
                const timerId = setTimeout(() => {
                  resolveTimersRef.current.delete(idx);
                  setResolvedIndices((r) => new Set([...r, idx]));
                  setFlashIndices((f) => new Set([...f, idx]));
                  // Remove flash class after animation completes (1.2 s)
                  setTimeout(() => {
                    setFlashIndices((f) => { const n = new Set(f); n.delete(idx); return n; });
                  }, 1200);
                }, 600);
                resolveTimersRef.current.set(idx, timerId);
              }
            }
            return incoming;
          });
        } catch (e) {
          if (e.status === 404) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      }, 1200);
    } catch (e) {
      setError(e.message || "failed to start recorder");
      setPhase("error");
    }
  }

  async function handleStopAndSave() {
    if (!sessionId) return;
    setPhase("stopping"); setError(null);
    try {
      const result = await api.recordStop(selectedProjectId, sessionId, {
        name: name.trim() || `Recorded flow @ ${new Date().toISOString()}`,
      });
      teardownStreams();
      sessionIdRef.current = null; setSessionId(null);
      onSaved?.(result.test); onClose?.();
    } catch (e) {
      setError(e.message || "failed to stop recorder");
      setPhase("error");
    }
  }

  async function handleAddAssertion() {
    if (!sessionId) return;
    if (assertKind !== "assertUrl" && !assertSelector.trim()) {
      setError("Selector is required for this verification."); return;
    }
    if ((assertKind === "assertText" || assertKind === "assertValue" || assertKind === "assertUrl" || assertKind === "assertCount" || assertKind === "assertHasClass") && !assertValue.trim()) {
      setError("Value is required for this verification."); return;
    }
    // DIF-015c Gap 2 — front-end mirrors the backend's
    // non-negative-integer guard so the user sees the error inline rather
    // than as a 400 banner from `addAssertionAction`.
    if (assertKind === "assertCount") {
      const n = Number.parseInt(assertValue.trim(), 10);
      if (!Number.isFinite(n) || n < 0 || String(n) !== assertValue.trim()) {
        setError("Count must be a non-negative integer."); return;
      }
    }
    setError(null);
    try {
      await api.recordAddAssertion(selectedProjectId, sessionId, {
        kind: assertKind,
        selector: assertKind === "assertUrl" ? undefined : assertSelector.trim(),
        label: assertLabel.trim() || undefined,
        value: assertValue.trim() || undefined,
      });
      setAssertValue("");
    } catch (e) {
      setError(e.message || "failed to add verification");
    }
  }

  async function armShortcutCapture() {
    if (!sessionId) return;
    try {
      await api.recordInput(selectedProjectId, sessionId, { type: "shortcutCapture", count: 3 });
      setShortcutArmed(true);
      window.setTimeout(() => setShortcutArmed(false), 4000);
    } catch {}
  }

  async function handlePauseResume() {
    if (!sessionId) return;
    try {
      if (paused) await api.recordResume(selectedProjectId, sessionId);
      else await api.recordPause(selectedProjectId, sessionId);
      setPaused(!paused);
    } catch (e) {
      setError(e.message || "failed to update recorder state");
    }
  }

  async function handleUndoLast() {
    if (!sessionId) return;
    try {
      const result = await api.recordPopLast(selectedProjectId, sessionId);
      // Use the server-authoritative `actionCount` for an absolute trim
      // rather than a relative `prev.slice(0, -1)`. If the 1200ms poll
      // already reflected the post-pop server state during the await
      // window, the relative slice would remove one extra action; the
      // absolute trim is a no-op in that case (length already matches).
      const target = Number.isFinite(result?.actionCount) ? result.actionCount : null;
      if (target !== null) {
        setActions((prev) => (prev.length > target ? prev.slice(0, target) : prev));
      } else {
        setActions((prev) => (prev.length ? prev.slice(0, -1) : prev));
      }
    } catch (e) {
      setError(e.message || "failed to undo last step");
    }
  }

  /**
   * DIF-015c Gap 5 — handler for the mid-session device dropdown.
   *
   * **Idle phase:** updates local state only; the server hasn't launched
   * yet, so the choice is applied at `recordStart` time via the body's
   * `device` field (see `handleStart`).
   *
   * **Recording phase:** opens a confirmation modal. The server-side
   * device swap tears down the current page+context, which means cookies,
   * partially-filled forms, and scroll position are lost — operators
   * need to know that before the rebuild fires. The actual API call
   * lives in `executeDeviceSwitch` below; the confirmation prompt sets
   * `pendingDeviceSwitch` to the requested device value and the modal's
   * "Switch device" button invokes the executor.
   */
  function handleDeviceChange(nextDevice) {
    if (phase !== "recording") {
      setDevice(nextDevice);
      return;
    }
    if (nextDevice === device) return; // no-op on same device
    setPendingDeviceSwitch(nextDevice);
  }

  /**
   * DIF-015c Gap 2 (point-and-click assert UX) — debounced hover probe
   * that POSTs the cursor's viewport coordinate to
   * `/record/:sessionId/probe` and renders the returned bounding rect
   * as a highlight overlay on the canvas. Debounce (~120 ms) keeps the
   * round-trip rate sensible at 60 fps mouse moves.
   *
   * The latest `{selector, label}` is stashed in `currentProbeRef` so
   * a subsequent click can commit the pick even if no fresh probe has
   * settled (rare race: operator clicks immediately after the canvas
   * gains focus, before the first hover probe has returned).
   */
  const handleProbe = useCallback(({ x, y }) => {
    if (!sessionIdRef.current) return;
    if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
    probeTimerRef.current = setTimeout(async () => {
      probeTimerRef.current = null;
      try {
        const { probe } = await api.recordProbe(projectIdRef.current, sessionIdRef.current, { x, y });
        if (!probe) {
          // No interactive ancestor under the cursor — drop the
          // highlight rather than show a stale outline. The pick
          // ref is also cleared so a click in this region falls
          // through to manual selector paste.
          setHighlightRect(null);
          currentProbeRef.current = null;
          return;
        }
        currentProbeRef.current = { selector: probe.selector, label: probe.label };
        setHighlightRect(probe.rect);
      } catch {
        // Page navigating mid-probe is normal — drop the highlight,
        // don't surface an error banner.
        setHighlightRect(null);
        currentProbeRef.current = null;
      }
    }, 120);
  }, []);

  /**
   * DIF-015c Gap 2 — commit the pick. Pre-fills the existing
   * verification form's selector + label fields with the latest probe
   * and exits assert mode so subsequent operator clicks return to
   * driving the page. The form's existing kind/value/Add button stay
   * unchanged — operators choose `assertVisible` / `assertText` / etc.
   * from the dropdown they already use.
   */
  function handlePick() {
    const probe = currentProbeRef.current;
    if (!probe) return;
    if (probe.selector) setAssertSelector(probe.selector);
    if (probe.label) setAssertLabel(probe.label);
    setAssertMode(false);
    setHighlightRect(null);
    currentProbeRef.current = null;
  }

  async function executeDeviceSwitch() {
    const nextDevice = pendingDeviceSwitch;
    if (nextDevice == null) return;
    setPendingDeviceSwitch(null);
    setDeviceSwitching(true);
    try {
      const result = await api.recordSwitchDevice(selectedProjectId, sessionId, nextDevice);
      setDevice(result.device || "");
      if (result.viewport?.width > 0 && result.viewport?.height > 0) {
        setViewport({ width: result.viewport.width, height: result.viewport.height });
      }
    } catch (e) {
      setError(e.message || "failed to switch device");
      // If the backend reported a hard rebuild failure (5xx with the
      // "torn down" message), the session is gone — drop the local
      // sessionId so the modal returns to the idle form rather than
      // dangling against a dead session.
      if (/torn down|Device switch failed/i.test(e.message || "")) {
        teardownStreams();
        sessionIdRef.current = null;
        setSessionId(null);
        setPhase("error");
      }
    } finally {
      setDeviceSwitching(false);
    }
  }

  function teardownStreams() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    for (const t of resolveTimersRef.current.values()) clearTimeout(t);
    resolveTimersRef.current.clear();
    setResolvedIndices(new Set());
    setFlashIndices(new Set());
    // DIF-015c Gap 2 — drop any in-flight probe timer + assert-mode
    // overlay so a teardown leaves no stale state for the next session.
    if (probeTimerRef.current) { clearTimeout(probeTimerRef.current); probeTimerRef.current = null; }
    currentProbeRef.current = null;
    setHighlightRect(null);
    setAssertMode(false);
  }

  function handleCancel() {
    // If actively recording, show confirmation first
    if (phase === "recording" || phase === "stopping") {
      setConfirmDiscard(true);
      return;
    }
    doDiscard();
  }

  async function doDiscard() {
    // Await the discard so the previous session's browser teardown
    // completes before the modal closes / re-launches. Fire-and-forget
    // here caused a race where the next `startRecording` raced against
    // the previous session's `stopRecording()` (which closes Chromium),
    // leaving the new session's CDP screencast attached to a browser
    // that was still in mid-teardown — symptom: black canvas with no
    // frames produced on the new session, until a hard refresh.
    setConfirmDiscard(false);
    if (sessionId) {
      try { await api.recordDiscard(selectedProjectId, sessionId); }
      catch { /* best-effort — server may have already auto-torn-down */ }
    }
    teardownStreams();
    sessionIdRef.current = null;
    setPhase("idle");
    setSessionId(null);
    setFrames([]);
    setActions([]);
    onClose?.();
  }

  if (!open) return null;

  const isIdle = phase === "idle" || phase === "error" || phase === "starting";

  return createPortal(
    <div
      ref={stageRef}
      className="recorder-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recorder-modal-title"
    >

      {/* ── Top bar ── */}
      <div className="recorder-topbar">
        <span className="recorder-topbar__emoji">🎥</span>
        <div className="recorder-topbar__title-group">
          <div>
            <div id="recorder-modal-title" className="recorder-topbar__title">Record a test</div>
            <div className="recorder-topbar__subtitle">
              Interact with the app in the live browser — every click, fill, and navigation is captured as a Playwright step.
            </div>
          </div>
          {(phase === "recording" || phase === "stopping") && (
            <div className="recorder-pulse">
              <span className="recorder-pulse__dot" />
              <span className="recorder-pulse__label">
                {phase === "stopping" ? "SAVING" : "RECORDING"}
              </span>
            </div>
          )}
        </div>

        {(phase === "recording" || phase === "stopping") && (
          <div className="recorder-stepcount">
            <span className="recorder-stepcount__num">{actions.length}</span> step{actions.length !== 1 ? "s" : ""} captured
          </div>
        )}

        <button onClick={handleCancel} className="recorder-exit-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {phase === "recording" || phase === "stopping" ? "Discard & Exit" : "Exit"}
        </button>
      </div>

      {/* ── IDLE: clean centred form ── */}
      {isIdle && (
        <div className="recorder-idle">
          <div className="recorder-idle__panel">
            <div className="recorder-idle__heading">New recording</div>
            <div className="recorder-idle__fields">
              {Array.isArray(projects) && projects.length > 1 && (
                <div>
                  <label className="recorder-idle__label recorder-idle__label--required">
                    Project <span className="recorder-idle__required">*</span>
                  </label>
                  <select
                    className="input recorder-idle__input"
                    value={selectedProjectId || ""}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* DIF-012: env picker — only renders when the project has at
                  least one configured environment. Selecting one swaps
                  Starting URL to the env's baseUrl via the auto-fill effect
                  above, and `recordStart` forwards `environmentId` to the
                  backend so the run record + audit trail capture the choice. */}
              {environments.length > 0 && (
                <div>
                  <label className="recorder-idle__label">Environment</label>
                  <select
                    className="input recorder-idle__input"
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
              {/* DIF-015c Gap 5 — Device profile picker. Mirrors the
                  same dropdown in RunRegressionModal so the recorder and
                  test runs surface the same curated list of viewports
                  + user agents. Empty string = desktop default; backend
                  validates against DEVICE_PRESETS in config.js. */}
              <div>
                <label className="recorder-idle__label">Device</label>
                <select
                  className="input recorder-idle__input"
                  value={device}
                  onChange={(e) => handleDeviceChange(e.target.value)}
                >
                  {DEVICE_PRESETS.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              </div>
              {/* DIF-015c Gap 6 — Stealth profile opt-in. Off by default
                  so pre-Gap-6 behaviour stays bit-for-bit unchanged. When
                  on, the backend installs STEALTH_SCRIPT before the
                  recorder script so `navigator.webdriver` is undefined
                  on the SUT's very first byte. The flag is immutable
                  post-launch — toggling at runtime would require a
                  context rebuild, which defeats the point. Help text
                  surfaces the cost/benefit so operators don't enable it
                  speculatively. */}
              <div>
                <label className="recorder-idle__label recorder-stealth-toggle">
                  <input
                    type="checkbox"
                    className="recorder-stealth-toggle__checkbox"
                    checked={stealth}
                    onChange={(e) => setStealth(e.target.checked)}
                  />
                  Stealth mode (bypass headless detection)
                </label>
                <div className="recorder-stealth-help">
                  Patches <code>navigator.webdriver</code> and 4 other
                  fingerprint surfaces so sites that block headless
                  browsers render normally. Off by default; opt in only
                  when a target SUT detects automation.
                </div>
              </div>
              <div>
                <label className="recorder-idle__label">Test name</label>
                <input
                  className="input recorder-idle__input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Login happy path"
                />
              </div>
              <div>
                <label className="recorder-idle__label recorder-idle__label--required">
                  Starting URL <span className="recorder-idle__required">*</span>
                </label>
                <input
                  className="input recorder-idle__input"
                  list="recorder-url-options"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://example.com"
                  onKeyDown={(e) => e.key === "Enter" && handleStart()}
                  autoFocus
                />
                <datalist id="recorder-url-options">
                  {urlOptions.map((u) => <option key={u} value={u} />)}
                </datalist>
              </div>
            </div>
            {error && <div className="banner banner-error recorder-error-banner">{error}</div>}
            <div className="recorder-idle__divider" />
            <div className="recorder-idle__actions">
              <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
              <button className="btn btn-primary recorder-idle__submit" onClick={handleStart} disabled={phase === "starting"}>
                {phase === "starting" ? "Launching…" : "Launch recorder"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── RECORDING: fixed two-column layout, sidebar never overflows ── */}
      {!isIdle && (
        <div className="recorder-stage">

          {/* Left — live browser, scrollable if needed */}
          <div className="recorder-stage__viewport">
            <LiveBrowserView
              frames={frames}
              label={sessionId || ""}
              onInput={handleInput}
              viewportW={viewport.width}
              viewportH={viewport.height}
              assertMode={assertMode}
              onProbe={handleProbe}
              onPick={handlePick}
              highlightRect={highlightRect}
            />
          </div>

          {/* Right sidebar — steps scroll, verification+name+save pinned at bottom */}
          <div className="recorder-sidebar">

            {/* TOP: Captured steps — takes all remaining space, scrolls internally */}
            <div className="recorder-sidebar__steps">
              {/* Recording-phase error banner. Surfaces failures from
                  pause/resume, undo, device switch, and add-verification
                  validation that would otherwise be silently swallowed —
                  the idle-phase banner at line ~668 only renders inside
                  `isIdle`, so without this duplicate the recorder swallows
                  every error a user could trigger after launch. Dismissible
                  via the `×` so a stale error doesn't linger after the
                  operator has seen it (next mutation that succeeds also
                  clears it via the existing `setError(null)` call sites). */}
              {error && (
                <div className="banner banner-error recorder-error-banner" role="alert">
                  <span>{error}</span>
                  <button
                    type="button"
                    className="recorder-error-banner__dismiss"
                    aria-label="Dismiss error"
                    onClick={() => setError(null)}
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="recorder-sidebar__heading">
                Captured steps ({actions.length})
              </div>
              {/* DIF-015c Gap 3 — pause/resume + undo. Buttons are
                  disabled during the `stopping` phase because the
                  server is tearing the session down; firing pause /
                  pop-last in that window would race the cleanup and
                  surface a 404 error banner. The undo button is also
                  disabled when there's nothing to undo. */}
              <div className="recorder-action-row">
                <button
                  className="btn btn-ghost"
                  onClick={handlePauseResume}
                  disabled={phase === "stopping"}
                >
                  {paused ? "Resume capture" : "Pause capture"}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={handleUndoLast}
                  disabled={phase === "stopping" || actions.length === 0}
                >
                  Undo last step
                </button>
              </div>
              {/* DIF-015c Gap 6 — Stealth-active badge on the recording
                  stage. The flag is immutable post-launch (changing it
                  would require a context rebuild that the operator
                  hasn't asked for), so this is a read-only indicator —
                  the operator sees at a glance whether the SUT is
                  receiving the patched navigator + chrome surfaces.
                  Suppressed when stealth is off so the recording stage
                  stays clutter-free for the common case. */}
              {stealth && (
                <div className="recorder-stealth-badge">
                  <span>🥷 Stealth mode active —</span>
                  <span className="recorder-stealth-badge__subtext">
                    headless fingerprints patched on every page
                  </span>
                </div>
              )}
              {/* DIF-015c Gap 5 — Mid-session device switch. Disabled
                  during `stopping` and during an in-flight switch so the
                  operator can't queue two teardowns. NEXT.md `:53`
                  acceptance: dropdown shows the same options as
                  RunRegressionModal, switching resizes the canvas,
                  selectors regenerate at the new pixel scale. */}
              <div className="recorder-device-picker">
                <label className="recorder-sidebar__footer-label" htmlFor="recorder-device-mid">
                  Device profile
                </label>
                <select
                  id="recorder-device-mid"
                  className="input"
                  value={device}
                  disabled={phase === "stopping" || deviceSwitching}
                  onChange={(e) => handleDeviceChange(e.target.value)}
                >
                  {DEVICE_PRESETS.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
                {deviceSwitching && (
                  <div className="recorder-device-picker__hint">
                    Switching device — rebuilding browser context…
                  </div>
                )}
              </div>
              <button className="btn btn-ghost recorder-shortcut-btn" onClick={armShortcutCapture}>
                {shortcutArmed ? "Shortcut capture armed (next 3 keys)" : "Record keyboard shortcut"}
              </button>
              <div className="recorder-sidebar__steps-list">
                {actions.length === 0 ? (
                  <div className="recorder-sidebar__steps-empty">
                    No actions yet — interact in the browser on the left.
                  </div>
                ) : (
                  <ol className="recorder-sidebar__steps-ol">
                    {actions.map((a, i) => {
                      const isResolved = resolvedIndices.has(i);
                      const isFlash = flashIndices.has(i);
                      const stepClass = [
                        "recorder-step",
                        isResolved ? "recorder-step--resolved" : "recorder-step--raw",
                        isFlash ? "recorder-step--flash" : "",
                      ].filter(Boolean).join(" ");
                      return (
                        <li key={i}>
                          <span className={stepClass}>
                            <span className="recorder-step__text">
                              {isResolved
                                ? actionToStepText(a)
                                : actionRawLocator(a)}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </div>

            {/* BOTTOM: Add verification + Test name + Stop & save — always pinned.
                Includes `stopping` so the disabled "Saving…" feedback stays
                visible while the save request is in flight (otherwise the
                whole panel unmounts the moment the user clicks the button). */}
            {(phase === "recording" || phase === "stopping") && (
              <div className="recorder-sidebar__footer">
                <div className="recorder-sidebar__heading" style={{ marginBottom: 2 }}>
                  Add verification
                </div>
                {/* DIF-015c Gap 2 — Pick-by-click toggle. When on, the
                    canvas swaps to inspect mode (crosshair cursor,
                    hover highlight, suppressed event forwarding) and
                    a click pre-fills the selector + label fields below
                    so the operator can finish picking the kind +
                    value + clicking "Add verification step" without
                    pasting a selector. NEXT.md `:51`: "No manual
                    selector paste required." */}
                <button
                  className="btn btn-ghost recorder-pick-toggle"
                  onClick={() => {
                    if (assertMode) {
                      // Cancel — drop any half-set probe state so the
                      // next entry into assert mode starts clean.
                      setHighlightRect(null);
                      currentProbeRef.current = null;
                    }
                    setAssertMode(!assertMode);
                  }}
                  disabled={phase === "stopping" || deviceSwitching}
                >
                  {assertMode
                    ? "✓ Pick mode active — click an element on the canvas"
                    : "🎯 Pick element by clicking"}
                </button>
                <select className="input" value={assertKind} onChange={(e) => setAssertKind(e.target.value)}>
                  <option value="assertVisible">Element visible</option>
                  <option value="assertText">Element contains text</option>
                  <option value="assertValue">Field has value</option>
                  <option value="assertUrl">URL contains</option>
                  {/* DIF-015c Gap 2 — count + class assertions. Backend
                      validates selector + value for both; assertCount
                      additionally requires a non-negative integer value. */}
                  <option value="assertCount">Element count equals</option>
                  <option value="assertHasClass">Element has class</option>
                </select>
                {assertKind !== "assertUrl" && (
                  <input className="input" value={assertSelector} onChange={(e) => setAssertSelector(e.target.value)}
                    placeholder='selector (e.g. role=button[name="Checkout"])' />
                )}
                <input className="input" value={assertLabel} onChange={(e) => setAssertLabel(e.target.value)}
                  placeholder="friendly label (optional)" />
                {(assertKind === "assertText" || assertKind === "assertValue" || assertKind === "assertUrl" || assertKind === "assertCount" || assertKind === "assertHasClass") && (
                  <input
                    className="input"
                    value={assertValue}
                    onChange={(e) => setAssertValue(e.target.value)}
                    type={assertKind === "assertCount" ? "number" : "text"}
                    min={assertKind === "assertCount" ? 0 : undefined}
                    placeholder={
                      assertKind === "assertUrl" ? "URL fragment or regex text"
                      : assertKind === "assertCount" ? "expected count (e.g. 3)"
                      : assertKind === "assertHasClass" ? "class name (e.g. is-loading)"
                      : "expected value"
                    }
                  />
                )}
                <button className="btn btn-ghost" onClick={handleAddAssertion}>
                  Add verification step
                </button>

                <div className="recorder-sidebar__footer-divider" />

                <label className="recorder-sidebar__footer-label">Test name</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Login happy path"
                />
                <button
                  className="btn btn-primary recorder-sidebar__footer-stop"
                  onClick={handleStopAndSave}
                  disabled={actions.length === 0 || phase === "stopping"}
                >
                  {phase === "stopping" ? "Saving…" : `Stop & save (${actions.length})`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* DIF-015c Gap 5 — Mid-session device switch confirmation. The
          server tears down the page+context to apply the new descriptor,
          so cookies / form state / scroll position are lost. Captured
          steps survive, but operators need to acknowledge the page-state
          reset before the rebuild fires. */}
      {pendingDeviceSwitch != null && (
        <div className="recorder-confirm">
          <div
            className="recorder-confirm__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recorder-device-switch-title"
          >
            <div className="recorder-confirm__head">
              <div id="recorder-device-switch-title" className="recorder-confirm__title">Switch device profile?</div>
            </div>
            <p className="recorder-confirm__body">
              Switching to <strong>{DEVICE_PRESETS.find((d) => d.value === pendingDeviceSwitch)?.label || pendingDeviceSwitch || "Desktop (default)"}</strong> rebuilds the browser context at the new viewport.
              <br /><br />
              Your <strong>{actions.length} captured step{actions.length !== 1 ? "s" : ""}</strong> will be preserved, but the page will reload — any open forms, cookies, and scroll position will be lost.
            </p>
            <div className="recorder-confirm__actions">
              <button className="recorder-confirm__keep" onClick={() => setPendingDeviceSwitch(null)}>
                Cancel
              </button>
              <button className="recorder-confirm__discard" onClick={executeDeviceSwitch}>
                Switch device
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Discard confirmation dialog ── */}
      {confirmDiscard && (
        <div className="recorder-confirm">
          <div
            className="recorder-confirm__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recorder-discard-title"
          >
            <div className="recorder-confirm__head">
              <div className="recorder-confirm__icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                </svg>
              </div>
              <div id="recorder-discard-title" className="recorder-confirm__title">Discard recording?</div>
            </div>

            <p className="recorder-confirm__body">
              You have <strong>{actions.length} step{actions.length !== 1 ? "s" : ""}</strong> recorded.
              Exiting now will permanently discard all of them.
            </p>

            <div className="recorder-confirm__actions">
              <button className="recorder-confirm__keep" onClick={() => setConfirmDiscard(false)}>
                Keep recording
              </button>
              <button className="recorder-confirm__discard" onClick={doDiscard}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                </svg>
                Discard & exit
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  , document.body);
}
