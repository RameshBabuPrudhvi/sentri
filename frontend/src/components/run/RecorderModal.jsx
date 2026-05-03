import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api.js";
import { API_PATH } from "../../utils/apiBase.js";
import { useSseStream } from "../../hooks/useSseStream.js";
import { actionToStepText, actionRawLocator } from "../../utils/actionToStepText.js";
import LiveBrowserView from "./LiveBrowserView.jsx";

export default function RecorderModal({ open, onClose, onSaved, projectId, defaultUrl = "", projects = null }) {
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
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  // Candidate URLs surfaced as a datalist suggestion list under the Starting
  // URL input — seed URL + any pages discovered on the latest successful
  // crawl. Fetched lazily when the modal opens so projects without a crawl
  // simply see the seed URL and an empty suggestion list.
  const [urlOptions, setUrlOptions] = useState([]);
  const pollRef = useRef(null);
  const sessionIdRef = useRef(null);
  const projectIdRef = useRef(projectId);
  const lastMoveRef = useRef(0);

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
      if (sessionIdRef.current && projectIdRef.current) {
        api.recordDiscard(projectIdRef.current, sessionIdRef.current).catch(() => {});
        sessionIdRef.current = null;
      }
    };
  }, []);

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
      const { sessionId: sid, viewport: vp } = await api.recordStart(selectedProjectId, { startUrl });
      setSessionId(sid);
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
    if ((assertKind === "assertText" || assertKind === "assertValue" || assertKind === "assertUrl") && !assertValue.trim()) {
      setError("Value is required for this verification."); return;
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

  function teardownStreams() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    for (const t of resolveTimersRef.current.values()) clearTimeout(t);
    resolveTimersRef.current.clear();
    setResolvedIndices(new Set());
    setFlashIndices(new Set());
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
    <div className="recorder-modal">

      {/* ── Top bar ── */}
      <div className="recorder-topbar">
        <span style={{ fontSize: 20 }}>🎥</span>
        <div className="recorder-topbar__title-group">
          <div>
            <div className="recorder-topbar__title">Record a test</div>
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
            {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}
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
            />
          </div>

          {/* Right sidebar — steps scroll, verification+name+save pinned at bottom */}
          <div className="recorder-sidebar">

            {/* TOP: Captured steps — takes all remaining space, scrolls internally */}
            <div className="recorder-sidebar__steps">
              <div className="recorder-sidebar__heading">
                Captured steps ({actions.length})
              </div>
              <button className="btn btn-ghost" onClick={armShortcutCapture} style={{ marginBottom: 8 }}>
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
                <select className="input" value={assertKind} onChange={(e) => setAssertKind(e.target.value)}>
                  <option value="assertVisible">Element visible</option>
                  <option value="assertText">Element contains text</option>
                  <option value="assertValue">Field has value</option>
                  <option value="assertUrl">URL contains</option>
                </select>
                {assertKind !== "assertUrl" && (
                  <input className="input" value={assertSelector} onChange={(e) => setAssertSelector(e.target.value)}
                    placeholder='selector (e.g. role=button[name="Checkout"])' />
                )}
                <input className="input" value={assertLabel} onChange={(e) => setAssertLabel(e.target.value)}
                  placeholder="friendly label (optional)" />
                {(assertKind === "assertText" || assertKind === "assertValue" || assertKind === "assertUrl") && (
                  <input className="input" value={assertValue} onChange={(e) => setAssertValue(e.target.value)}
                    placeholder={assertKind === "assertUrl" ? "URL fragment or regex text" : "expected value"} />
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

      {/* ── Discard confirmation dialog ── */}
      {confirmDiscard && (
        <div className="recorder-confirm">
          <div className="recorder-confirm__dialog">
            <div className="recorder-confirm__head">
              <div className="recorder-confirm__icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                </svg>
              </div>
              <div className="recorder-confirm__title">Discard recording?</div>
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