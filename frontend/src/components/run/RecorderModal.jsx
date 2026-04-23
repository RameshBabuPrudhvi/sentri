import { useEffect, useRef, useState } from "react";
import { api } from "../../api.js";
import { API_PATH } from "../../utils/apiBase.js";
import LiveBrowserView from "./LiveBrowserView.jsx";

/**
 * RecorderModal — DIF-015 interactive browser recorder.
 *
 * Opens a server-side Playwright browser at the target URL, subscribes to the
 * CDP screencast SSE channel for live frames, polls for the growing action
 * list, and on "Stop & Save" persists the capture as a Draft Playwright test.
 *
 * Props:
 *   open          — boolean
 *   onClose       — () => void, called after close regardless of outcome
 *   onSaved       — (test) => void, called with the created Draft test row
 *   projectId     — string
 *   defaultUrl    — string, pre-populated into the start-URL input
 */
export default function RecorderModal({ open, onClose, onSaved, projectId, defaultUrl = "" }) {
  const [phase, setPhase] = useState("idle"); // idle | starting | recording | stopping | error
  const [startUrl, setStartUrl] = useState(defaultUrl);
  const [sessionId, setSessionId] = useState(null);
  const [actions, setActions] = useState([]);
  const [frames, setFrames] = useState([]);
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const esRef = useRef(null);
  const pollRef = useRef(null);
  // Refs mirror sessionId + projectId so the unmount cleanup sees the latest
  // values. An empty-deps cleanup closure would otherwise capture the initial
  // `sessionId = null` and never call `recordDiscard`, leaking the server-side
  // Chromium process when the user navigates away mid-recording.
  const sessionIdRef = useRef(null);
  const projectIdRef = useRef(projectId);

  useEffect(() => {
    setStartUrl(defaultUrl);
  }, [defaultUrl]);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);

  // Clean up SSE + polling AND server-side recording session on unmount.
  useEffect(() => {
    return () => {
      if (esRef.current) { try { esRef.current.close(); } catch {} esRef.current = null; }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (sessionIdRef.current && projectIdRef.current) {
        api.recordDiscard(projectIdRef.current, sessionIdRef.current).catch(() => {});
        sessionIdRef.current = null;
      }
    };
  }, []);

  async function handleStart() {
    setError(null);
    setActions([]);
    setFrames([]);
    if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
      setError("Enter a valid http(s) URL to record from.");
      return;
    }
    // If a previous handleStopAndSave failed, `sessionId` still points at a
    // live server-side Chromium process. Fire a best-effort discard before
    // launching a new session so clicking "Launch recorder" a second time
    // doesn't orphan the previous browser until MAX_RECORDING_MS fires.
    const stale = sessionIdRef.current;
    if (stale) {
      const staleProject = projectIdRef.current || projectId;
      api.recordDiscard(staleProject, stale).catch(() => {});
      sessionIdRef.current = null;
      setSessionId(null);
    }
    // Also tear down any still-running SSE / poller from the previous
    // attempt before they race with the new session's streams.
    teardownStreams();
    setPhase("starting");
    try {
      const { sessionId: sid } = await api.recordStart(projectId, { startUrl });
      setSessionId(sid);
      setPhase("recording");

      // Open SSE to receive live screencast frames from the recorder browser.
      const es = new EventSource(`${API_PATH}/runs/${sid}/events`, { withCredentials: true });
      esRef.current = es;
      es.addEventListener("frame", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data && data.data) setFrames([data.data]);
        } catch { /* ignore malformed frame */ }
      });
      es.onerror = () => { /* SSE auto-reconnects; no action needed */ };

      // Poll for the captured actions so the sidebar updates as the user clicks.
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.recordStatus(projectId, sid);
          setActions(status.actions || []);
        } catch (e) {
          if (e.status === 404) {
            // Session ended server-side — stop polling.
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      }, 1200);
    } catch (e) {
      setError(e.message || "failed to start recorder");
      setPhase("error");
    }
  }

  async function handleStopAndSave() {
    if (!sessionId) return;
    setPhase("stopping");
    setError(null);
    try {
      const result = await api.recordStop(projectId, sessionId, {
        name: name.trim() || `Recorded flow @ ${new Date().toISOString()}`,
      });
      teardownStreams();
      // Clear the ref so the unmount cleanup doesn't fire a redundant
      // recordDiscard for a session we've already stopped.
      sessionIdRef.current = null;
      setSessionId(null);
      onSaved?.(result.test);
      onClose?.();
    } catch (e) {
      setError(e.message || "failed to stop recorder");
      setPhase("error");
    }
  }

  function teardownStreams() {
    if (esRef.current) { try { esRef.current.close(); } catch {} esRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  function handleCancel() {
    // If a session was started, tear down the browser server-side via the
    // dedicated discard path. `recordDiscard` tells the stop endpoint not to
    // persist a Draft test, so an abandoned recording does not leave junk
    // rows in the DB. Best-effort — any error is swallowed.
    if (sessionId) {
      api.recordDiscard(projectId, sessionId).catch(() => {});
    }
    teardownStreams();
    // Clear the ref immediately so the unmount cleanup doesn't fire a second
    // discard for the same session we just tore down.
    sessionIdRef.current = null;
    setPhase("idle");
    setSessionId(null);
    onClose?.();
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={handleCancel}>
      <div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 980, width: "95vw", padding: 0, display: "flex", flexDirection: "column", maxHeight: "90vh" }}
      >
        {/* Header */}
        <div style={{
          padding: "14px 20px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ fontSize: 20 }}>🎥</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>Record a test</div>
            <div style={{ fontSize: "0.74rem", color: "var(--text3)" }}>
              Interact with the app in the live browser — every click, fill, and navigation is captured as a Playwright step.
            </div>
          </div>
          <button className="modal-close" onClick={handleCancel} aria-label="Close">×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1fr 300px", gap: 16, overflow: "auto" }}>
          {/* Left — live browser */}
          <div>
            {phase === "idle" || phase === "error" ? (
              <div>
                <label className="text-sm font-semi" style={{ display: "block", marginBottom: 6 }}>Start URL</label>
                <input
                  className="input"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://example.com"
                  style={{ width: "100%", marginBottom: 12 }}
                />
                <button className="btn btn-primary" onClick={handleStart}>
                  Launch recorder
                </button>
                {error && (
                  <div className="banner banner-error" style={{ marginTop: 12 }}>{error}</div>
                )}
              </div>
            ) : (
              <LiveBrowserView frames={frames} label={sessionId || ""} />
            )}
          </div>

          {/* Right — captured actions */}
          <div style={{ display: "flex", flexDirection: "column", minHeight: 300 }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              Captured steps ({actions.length})
            </div>
            <div style={{ flex: 1, overflow: "auto", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg2)" }}>
              {actions.length === 0 ? (
                <div style={{ padding: 16, fontSize: "0.76rem", color: "var(--text3)", fontStyle: "italic" }}>
                  No actions captured yet. Click, type, or navigate in the live browser on the left.
                </div>
              ) : (
                <ol style={{ margin: 0, padding: "10px 14px 10px 30px", fontSize: "0.75rem", fontFamily: "var(--font-mono)", color: "var(--text2)" }}>
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

            {phase === "recording" && (
              <div style={{ marginTop: 12 }}>
                <label className="text-sm font-semi" style={{ display: "block", marginBottom: 6 }}>Test name</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Login happy path"
                  style={{ width: "100%", marginBottom: 10 }}
                />
                <button
                  className="btn btn-primary"
                  onClick={handleStopAndSave}
                  disabled={actions.length === 0 || phase === "stopping"}
                  style={{ width: "100%" }}
                >
                  {phase === "stopping" ? "Saving…" : `Stop & save (${actions.length})`}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: "10px 20px", borderTop: "1px solid var(--border)",
          display: "flex", justifyContent: "flex-end", gap: 8,
        }}>
          <button className="btn btn-ghost" onClick={handleCancel}>
            {phase === "recording" ? "Discard" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
