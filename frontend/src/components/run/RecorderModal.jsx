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
    <div style={{
      position: "fixed",
      top: 0, left: 0, right: 0, bottom: 0,
      width: "100vw", height: "100vh",
      zIndex: 99999,
      background: "var(--bg)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      cursor: "default",
    }}>

      {/* ── Top bar ── */}
      <div style={{
        height: 52,
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 20px",
        flexShrink: 0,
        background: "var(--bg)",
      }}>
        <span style={{ fontSize: 20 }}>🎥</span>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: "0.95rem", lineHeight: 1.2 }}>Record a test</div>
            <div style={{ fontSize: "0.74rem", color: "var(--text3)" }}>
              Interact with the app in the live browser — every click, fill, and navigation is captured as a Playwright step.
            </div>
          </div>
          {/* Recording pulse indicator */}
          {(phase === "recording" || phase === "stopping") && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 20, background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.25)" }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%", background: "#dc2626",
                display: "inline-block",
                animation: "sentri-pulse 1.4s ease-in-out infinite",
              }} />
              <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#dc2626", letterSpacing: "0.04em" }}>
                {phase === "stopping" ? "SAVING" : "RECORDING"}
              </span>
            </div>
          )}
        </div>

        {/* Step count badge — visible while recording */}
        {(phase === "recording" || phase === "stopping") && (
          <div style={{ fontSize: "0.78rem", color: "var(--text3)", marginRight: 8 }}>
            <span style={{ fontWeight: 700, color: "var(--text)" }}>{actions.length}</span> step{actions.length !== 1 ? "s" : ""} captured
          </div>
        )}

        <button
          onClick={handleCancel}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 14px", borderRadius: 6,
            border: "1px solid var(--border)", background: "var(--bg2)",
            color: "var(--text)", fontSize: "0.82rem", fontWeight: 600,
            cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {phase === "recording" || phase === "stopping" ? "Discard & Exit" : "Exit"}
        </button>
      </div>

      {/* Pulse keyframe injected once */}
      <style>{`@keyframes sentri-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {/* ── IDLE: clean centred form ── */}
      {isIdle && (
        <div style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "auto",
          background: "var(--bg)",
        }}>
          <div style={{ width: 560 }}>
            <div style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text)", marginBottom: 20 }}>
              New recording
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 24 }}>
              <div>
                <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
                  Test name
                </label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Login happy path"
                  style={{ width: "100%", fontSize: "0.9rem" }}
                />
              </div>
              <div>
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.82rem", fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
                  Starting URL <span style={{ color: "var(--accent)" }}>*</span>
                </label>
                <input
                  className="input"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://example.com"
                  style={{ width: "100%", fontSize: "0.9rem" }}
                  onKeyDown={(e) => e.key === "Enter" && handleStart()}
                  autoFocus
                />
              </div>
            </div>
            {error && <div className="banner banner-error" style={{ marginBottom: 16 }}>{error}</div>}
            <div style={{ borderTop: "1px solid var(--border)", marginBottom: 20 }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
              <button className="btn btn-primary" onClick={handleStart} disabled={phase === "starting"} style={{ minWidth: 148 }}>
                {phase === "starting" ? "Launching…" : "Launch recorder"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── RECORDING: fixed two-column layout, sidebar never overflows ── */}
      {!isIdle && (
        <div style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",    /* KEY: prevents full-page scroll */
          gap: 0,
        }}>

          {/* Left — live browser, scrollable if needed */}
          <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
            <LiveBrowserView
              frames={frames}
              label={sessionId || ""}
              onInput={handleInput}
              viewportW={viewport.width}
              viewportH={viewport.height}
            />
          </div>

          {/* Right sidebar — steps scroll, verification+name+save pinned at bottom */}
          <div style={{
            width: 300,
            background: "var(--bg2, #f7f8fa)",
            borderLeft: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            flexShrink: 0,
          }}>

            {/* TOP: Captured steps — takes all remaining space, scrolls internally */}
            <div style={{ flex: 1, overflow: "hidden", padding: "14px 14px 0", display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8, flexShrink: 0 }}>
                Captured steps ({actions.length})
              </div>
              <div style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", overflow: "auto", minHeight: 0 }}>
                {actions.length === 0 ? (
                  <div style={{ padding: 14, fontSize: "0.74rem", color: "var(--text3)", fontStyle: "italic" }}>
                    No actions yet — interact in the browser on the left.
                  </div>
                ) : (
                  <ol style={{ margin: 0, padding: "10px 12px 10px 28px", fontSize: "0.73rem", fontFamily: "var(--font-mono)", color: "var(--text2)" }}>
                    {actions.map((a, i) => (
                      <li key={i} style={{ marginBottom: 4, lineHeight: 1.5 }}>
                        <span style={{ fontWeight: 700, color: "var(--accent)" }}>{a.kind}</span>
                        {a.selector && <span style={{ color: "var(--text3)" }}> → {a.selector}</span>}
                        {a.value && <span style={{ color: "var(--green)" }}> = "{a.value.slice(0, 40)}"</span>}
                        {a.url && <span style={{ color: "var(--blue)" }}> {a.url}</span>}
                        {a.key && <span style={{ color: "var(--amber)" }}> {a.key}</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>

            {/* BOTTOM: Add verification + Test name + Stop & save — always pinned */}
            {phase === "recording" && (
              <div style={{
                flexShrink: 0,
                borderTop: "1px solid var(--border)",
                background: "var(--bg2, #f7f8fa)",
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}>
                {/* Verification */}
                <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
                  Add verification
                </div>
                <select className="input" value={assertKind} onChange={(e) => setAssertKind(e.target.value)} style={{ width: "100%" }}>
                  <option value="assertVisible">Element visible</option>
                  <option value="assertText">Element contains text</option>
                  <option value="assertValue">Field has value</option>
                  <option value="assertUrl">URL contains</option>
                </select>
                {assertKind !== "assertUrl" && (
                  <input className="input" value={assertSelector} onChange={(e) => setAssertSelector(e.target.value)}
                    placeholder='selector (e.g. role=button[name="Checkout"])' style={{ width: "100%" }} />
                )}
                <input className="input" value={assertLabel} onChange={(e) => setAssertLabel(e.target.value)}
                  placeholder="friendly label (optional)" style={{ width: "100%" }} />
                {(assertKind === "assertText" || assertKind === "assertValue" || assertKind === "assertUrl") && (
                  <input className="input" value={assertValue} onChange={(e) => setAssertValue(e.target.value)}
                    placeholder={assertKind === "assertUrl" ? "URL fragment or regex text" : "expected value"}
                    style={{ width: "100%" }} />
                )}
                <button className="btn btn-ghost" onClick={handleAddAssertion} style={{ width: "100%" }}>
                  Add verification step
                </button>

                {/* Divider */}
                <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />

                {/* Test name + Stop & save */}
                <label style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text)" }}>
                  Test name
                </label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Login happy path"
                  style={{ width: "100%" }}
                />
                <button
                  className="btn btn-primary"
                  onClick={handleStopAndSave}
                  disabled={actions.length === 0 || phase === "stopping"}
                  style={{ width: "100%", fontWeight: 700, marginTop: 2 }}
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
        <div style={{
          position: "absolute",
          inset: 0,
          zIndex: 10,
          background: "rgba(0,0,0,0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
          <div style={{
            background: "var(--bg)",
            borderRadius: 14,
            padding: "28px 28px 20px",
            width: 380,
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
            border: "1px solid var(--border)",
          }}>
            {/* Icon + title */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                background: "rgba(220,38,38,0.1)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                </svg>
              </div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text)" }}>
                Discard recording?
              </div>
            </div>

            <p style={{ fontSize: "0.85rem", color: "var(--text2)", lineHeight: 1.6, margin: "0 0 22px" }}>
              You have <strong>{actions.length} step{actions.length !== 1 ? "s" : ""}</strong> recorded.
              Exiting now will permanently discard all of them.
            </p>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setConfirmDiscard(false)}
                style={{
                  padding: "7px 16px", borderRadius: 7, border: "1px solid var(--border)",
                  background: "var(--bg2)", color: "var(--text)", fontSize: "0.85rem",
                  fontWeight: 600, cursor: "pointer",
                }}
              >
                Keep recording
              </button>
              <button
                onClick={doDiscard}
                style={{
                  padding: "7px 16px", borderRadius: 7, border: "none",
                  background: "#dc2626", color: "#fff", fontSize: "0.85rem",
                  fontWeight: 700, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
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