import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api.js";
import { API_PATH } from "../../utils/apiBase.js";
import { useSseStream } from "../../hooks/useSseStream.js";
import LiveBrowserView from "./LiveBrowserView.jsx";

export default function RecorderModal({ open, onClose, onSaved, projectId, defaultUrl = "" }) {
  const [phase, setPhase] = useState("idle");
  const [startUrl, setStartUrl] = useState(defaultUrl);
  const [sessionId, setSessionId] = useState(null);
  const [actions, setActions] = useState([]);
  const [frames, setFrames] = useState([]);
  const [name, setName] = useState("");
  const [assertKind, setAssertKind] = useState("assertVisible");
  const [assertSelector, setAssertSelector] = useState("");
  const [assertValue, setAssertValue] = useState("");
  const [assertLabel, setAssertLabel] = useState("");
  const [error, setError] = useState(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [shortcutArmed, setShortcutArmed] = useState(false);
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
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
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);

  const sseUrl = sessionId ? `${API_PATH}/runs/${sessionId}/events` : null;
  useSseStream(sseUrl, useCallback((event) => {
    if (event?.type === "frame" && event.data) setFrames([event.data]);
  }, []), Boolean(sessionId));

  useEffect(() => {
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (sessionIdRef.current && projectIdRef.current) {
        api.recordDiscard(projectIdRef.current, sessionIdRef.current).catch(() => {});
        sessionIdRef.current = null;
      }
    };
  }, []);

  async function handleStart() {
    setError(null); setActions([]); setFrames([]);
    if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
      setError("Enter a valid http(s) URL to record from."); return;
    }
    const stale = sessionIdRef.current;
    if (stale) {
      api.recordDiscard(projectIdRef.current || projectId, stale).catch(() => {});
      sessionIdRef.current = null; setSessionId(null);
    }
    teardownStreams();
    setPhase("starting");
    try {
      const { sessionId: sid, viewport: vp } = await api.recordStart(projectId, { startUrl });
      setSessionId(sid);
      if (vp && vp.width > 0 && vp.height > 0) setViewport({ width: vp.width, height: vp.height });
      setPhase("recording");
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.recordStatus(projectId, sid);
          setActions(status.actions || []);
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
      const result = await api.recordStop(projectId, sessionId, {
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
      await api.recordAddAssertion(projectId, sessionId, {
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
      await api.recordInput(projectId, sessionId, { type: "shortcutCapture", count: 3 });
      setShortcutArmed(true);
      window.setTimeout(() => setShortcutArmed(false), 4000);
    } catch {}
  }

  function teardownStreams() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  function handleCancel() {
    // If actively recording, show confirmation first
    if (phase === "recording" || phase === "stopping") {
      setConfirmDiscard(true);
      return;
    }
    doDiscard();
  }

  function doDiscard() {
    if (sessionId) api.recordDiscard(projectId, sessionId).catch(() => {});
    teardownStreams();
    sessionIdRef.current = null;
    setConfirmDiscard(false);
    setPhase("idle");
    setSessionId(null);
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
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://example.com"
                  onKeyDown={(e) => e.key === "Enter" && handleStart()}
                  autoFocus
                />
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
                    {actions.map((a, i) => (
                      <li key={i}>
                        <span className="recorder-step__kind">{a.kind}</span>
                        {a.selector && <span className="recorder-step__selector"> → {a.selector}</span>}
                        {a.value && <span className="recorder-step__value"> = "{a.value.slice(0, 40)}"</span>}
                        {a.url && <span className="recorder-step__url"> {a.url}</span>}
                        {a.key && <span className="recorder-step__key"> {a.key}</span>}
                      </li>
                    ))}
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
