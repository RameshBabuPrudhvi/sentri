import React, { useCallback, useEffect, useRef } from "react";
import {
  Info, RefreshCw, Terminal, Wifi, WifiOff,
} from "lucide-react";
import { useOllamaStatusQuery } from "../../../../hooks/queries/useSettingsQueries.js";

/**
 * Ollama status panel — shown inside the local provider card. Polls
 * `/api/v1/settings/ollama-status` via TanStack Query, surfaces connection
 * + available-models state, lets the operator pick a model from the
 * detected list or type one manually. Extracted from Settings.jsx
 * (GAP-002).
 *
 * AGENT.md §127 compliance: all inline styles from the legacy component
 * were replaced with the `.ollama-*` CSS classes in
 * `frontend/src/styles/pages/settings.css`. The only data-driven branch
 * is the status background, which maps to a CSS class modifier
 * (`ollama-status--ok` / `--err` / `--unknown`) rather than inline values.
 */
export default function OllamaStatusPanel({ baseUrl, model, onModelChange, onBaseUrlChange }) {
  // Refs avoid re-triggering the model-sync effect when model/callback change.
  const modelRef = useRef(model);
  const onModelChangeRef = useRef(onModelChange);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { onModelChangeRef.current = onModelChange; }, [onModelChange]);

  const statusQuery = useOllamaStatusQuery();
  const status = statusQuery.data ?? null;
  const checking = statusQuery.isFetching;
  const check = useCallback(() => statusQuery.refetch(), [statusQuery]);

  // Sync model state to the exact option value returned by Ollama so the
  // controlled <select> stays in sync. Ollama tags include a `:latest`
  // suffix that the saved config may omit (`mistral:7b` vs
  // `mistral:7b:latest`), causing a value mismatch → flicker loop.
  useEffect(() => {
    if (!status?.availableModels?.length) return;
    const cur = modelRef.current;
    if (!status.availableModels.includes(cur)) {
      const match = status.availableModels.find((m) => m.split(":")[0] === cur.split(":")[0]);
      if (match) onModelChangeRef.current(match);
    }
  }, [status]);

  const statusModifier = status == null
    ? "ollama-status--unknown"
    : status.ok
    ? "ollama-status--ok"
    : "ollama-status--err";

  return (
    <div className="ollama-panel">
      <hr className="divider" />

      {/* Connection status */}
      <div className={`ollama-status ${statusModifier}`}>
        {checking
          ? <RefreshCw size={14} color="var(--text3)" className="spin shrink-0 ollama-status__icon" />
          : status?.ok
          ? <Wifi size={14} color="var(--green)" className="shrink-0 ollama-status__icon" />
          : <WifiOff size={14} color="var(--red)" className="shrink-0 ollama-status__icon" />}
        <div className="flex-1 ollama-status__body">
          {status == null || checking
            ? <span className="text-sm text-sub">Checking Ollama…</span>
            : status.ok
            ? <span className="ollama-status__connected">
                Connected · <span className="text-mono">{status.model}</span>
              </span>
            : <span className="ollama-status__error">{status.error}</span>}
        </div>
        <button className="btn btn-ghost btn-xs shrink-0 ollama-status__check-btn" onClick={check} disabled={checking}>
          <RefreshCw size={11} className={checking ? "spin" : undefined} /> Check
        </button>
      </div>
      {!status?.ok && status != null && !checking && (
        <div className="hint ollama-italic-hint">
          Status reflects the last saved config. Click &quot;Activate Ollama&quot; first if you changed the URL or model above.
        </div>
      )}

      {/* Available models dropdown */}
      {status?.availableModels?.length > 0 && (
        <div>
          <label className="ollama-label">Active model</label>
          <select
            className="input ollama-select"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {status.availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <div className="hint">
            Only models you have pulled with <code className="ollama-code-inline">ollama pull &lt;model&gt;</code> appear here.
          </div>
        </div>
      )}

      {/* Manual model name input when list is empty or connection failed */}
      {(!status?.availableModels?.length) && (
        <div>
          <label className="ollama-label">Model name</label>
          <input
            className="input ollama-input--mono"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="mistral:7b"
          />
        </div>
      )}

      {/* Ollama base URL */}
      <div>
        <label className="ollama-label">Ollama base URL</label>
        <input
          className="input ollama-input--url"
          value={baseUrl}
          onChange={(e) => onBaseUrlChange(e.target.value)}
          placeholder="http://localhost:11434"
        />
        <div className="hint">
          Change this if Ollama is running on a remote host or a different port.
        </div>
      </div>

      {/* Quick-start instructions */}
      <div className="card-padded-sm ollama-quickstart-card">
        <div className="font-semi text-xs ollama-quickstart__title">
          <Terminal size={13} color="var(--text2)" /> Quick start
        </div>
        <pre className="text-mono text-sub ollama-quickstart__pre">{
`# 1. Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# 2. Pull a model (one-time download)
ollama pull mistral:7b          # ~2 GB, good quality
ollama pull qwen2.5-coder:7b  # great for code generation
ollama pull mistral           # lighter alternative

# 3. Start the server
ollama serve                  # default: http://localhost:11434`
        }</pre>
      </div>

      <div className="hint ollama-tip">
        <Info size={11} className="shrink-0 ollama-tip__icon" />
        <span>
          For best results use a model with strong JSON output and code generation.
          Recommended: <strong>mistral:7b</strong>, <strong>qwen2.5-coder:7b</strong>, <strong>mistral</strong>.
          Small models (≤3B) may struggle to produce valid Playwright code.
        </span>
      </div>
    </div>
  );
}
