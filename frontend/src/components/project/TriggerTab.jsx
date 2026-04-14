/**
 * TriggerTab — CI/CD webhook token management (ENH-011).
 *
 * Renders inside ProjectDetail under the "Trigger" tab. Provides:
 *   - A "Create token" form with optional label
 *   - One-time token reveal banner (plaintext shown once, never again)
 *   - Token list with last-used timestamp and revoke button
 *   - Copy-to-clipboard YAML snippets for GitHub Actions, GitLab CI, and cURL
 *
 * @param {{ projectId: string, projectUrl: string }} props
 */

import { useState, useEffect, useCallback } from "react";
import { Copy, Check, Plus, Trash2, Zap } from "lucide-react";
import { api } from "../../api.js";

// ─── Small helpers ─────────────────────────────────────────────────────────────

function CopyButton({ text, className = "btn btn-ghost btn-xs" }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button className={className} onClick={copy} title="Copy to clipboard">
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium", timeStyle: "short",
  });
}

// ─── Snippet builders ──────────────────────────────────────────────────────────

function ghActionsSnippet(projectId, apiBase) {
  return `# .github/workflows/sentri.yml
name: Sentri regression

on:
  push:
    branches: [main]

jobs:
  sentri:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Sentri test run
        id: trigger
        run: |
          response=$(curl -sf -X POST \\
            -H "Authorization: Bearer \${{ secrets.SENTRI_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            "${apiBase}/api/projects/${projectId}/trigger")
          echo "run_id=$(echo $response | jq -r .runId)" >> $GITHUB_OUTPUT
          echo "status_url=$(echo $response | jq -r .statusUrl)" >> $GITHUB_OUTPUT

      - name: Wait for run to complete
        run: |
          status_url="\${{ steps.trigger.outputs.status_url }}"
          for i in $(seq 1 60); do
            status=$(curl -sf "$status_url" | jq -r .status)
            echo "Run status: $status"
            [ "$status" != "running" ] && break
            sleep 10
          done
          [ "$status" = "completed" ] || exit 1`.trim();
}

function gitlabSnippet(projectId, apiBase) {
  return `# .gitlab-ci.yml
sentri:
  stage: test
  script:
    - |
      response=$(curl -sf -X POST \\
        -H "Authorization: Bearer $SENTRI_TOKEN" \\
        -H "Content-Type: application/json" \\
        "${apiBase}/api/projects/${projectId}/trigger")
      STATUS_URL=$(echo $response | jq -r .statusUrl)
      for i in $(seq 1 60); do
        STATUS=$(curl -sf "$STATUS_URL" | jq -r .status)
        echo "Run status: $STATUS"
        [ "$STATUS" != "running" ] && break
        sleep 10
      done
      [ "$STATUS" = "completed" ]`.trim();
}

function curlSnippet(projectId, apiBase) {
  return `curl -X POST \\
  -H "Authorization: Bearer <YOUR_TOKEN>" \\
  -H "Content-Type: application/json" \\
  "${apiBase}/api/projects/${projectId}/trigger"`.trim();
}

// ─── Token reveal banner (shown once) ────────────────────────────────────────

function TokenReveal({ token, onDismiss }) {
  return (
    <div className="trigger-token-reveal">
      <div className="trigger-token-reveal-label">
        ✅ Token created — copy it now, it will not be shown again
      </div>
      <div className="trigger-token-value">{token}</div>
      <div className="trigger-token-reveal-actions">
        <CopyButton text={token} className="btn btn-sm" />
        <button className="btn btn-ghost btn-sm" onClick={onDismiss}>Dismiss</button>
      </div>
      <div className="trigger-token-reveal-warning">
        ⚠️ Store this token securely (e.g. as a CI secret). It cannot be retrieved after dismissal.
      </div>
    </div>
  );
}

// ─── Snippet block ────────────────────────────────────────────────────────────

function Snippet({ label, code }) {
  return (
    <div className="trigger-snippet">
      <div className="trigger-snippet-label">{label}</div>
      <pre>{code}</pre>
      <div className="trigger-snippet-copy">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TriggerTab({ projectId, projectUrl }) {
  const [tokens, setTokens]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [creating, setCreating]     = useState(false);
  const [label, setLabel]           = useState("");
  const [newToken, setNewToken]     = useState(null); // plaintext reveal
  const [revoking, setRevoking]     = useState(null); // tokenId being deleted
  const [error, setError]           = useState(null);

  // Derive the API base from the current page origin so snippets work for
  // self-hosted and cloud deployments alike.
  const apiBase = typeof window !== "undefined"
    ? window.location.origin
    : "";

  const loadTokens = useCallback(async () => {
    try {
      const data = await api.getTriggerTokens(projectId);
      setTokens(data);
    } catch {
      setError("Failed to load tokens.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadTokens(); }, [loadTokens]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await api.createTriggerToken(projectId, { label: label.trim() || undefined });
      setNewToken(res.token);
      setLabel("");
      // Reload token list (new entry without the plaintext)
      await loadTokens();
    } catch (err) {
      setError(err.message || "Failed to create token.");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId) => {
    if (!confirm("Permanently revoke this token? CI pipelines using it will stop working immediately.")) return;
    setRevoking(tokenId);
    try {
      await api.deleteTriggerToken(projectId, tokenId);
      setTokens((prev) => prev.filter((t) => t.id !== tokenId));
      if (newToken) setNewToken(null); // dismiss reveal if it was for this token
    } catch {
      setError("Failed to revoke token.");
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="trigger-section">

      {/* ── One-time reveal ──────────────────────────────────────────────── */}
      {newToken && (
        <TokenReveal token={newToken} onDismiss={() => setNewToken(null)} />
      )}

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {error && (
        <div className="banner banner-error" style={{ marginBottom: 0 }}>
          {error}
          <button className="btn btn-ghost btn-xs" style={{ marginLeft: "auto" }}
            onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* ── Token management ─────────────────────────────────────────────── */}
      <div className="card card-padded">
        <div className="trigger-section-title">Trigger tokens</div>

        {/* Create form */}
        <form onSubmit={handleCreate}
          style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 200px", minWidth: 160 }}
            placeholder="Token label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={120}
            disabled={creating}
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={creating}>
            <Plus size={14} />
            {creating ? "Creating…" : "New token"}
          </button>
        </form>

        {/* Token list */}
        {loading ? (
          <div className="trigger-token-empty">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="trigger-token-empty">
            No tokens yet — create one above to enable CI/CD triggers.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Label</th>
                <th>Created</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td><span className="mono-id">{t.id}</span></td>
                  <td style={{ color: t.label ? "var(--text1)" : "var(--text3)" }}>
                    {t.label || <em>unlabelled</em>}
                  </td>
                  <td style={{ color: "var(--text2)", fontSize: "0.8rem" }}>{fmtDate(t.createdAt)}</td>
                  <td style={{ color: "var(--text2)", fontSize: "0.8rem" }}>{fmtDate(t.lastUsedAt)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ color: "var(--red)" }}
                      disabled={revoking === t.id}
                      onClick={() => handleRevoke(t.id)}
                      title="Revoke token"
                    >
                      <Trash2 size={13} />
                      {revoking === t.id ? "Revoking…" : "Revoke"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Usage snippets ────────────────────────────────────────────────── */}
      <div className="card card-padded">
        <div className="trigger-section-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Zap size={13} />
          Integration snippets
        </div>
        <p style={{ fontSize: "0.83rem", color: "var(--text2)", marginBottom: 20, marginTop: 0 }}>
          Use these in your CI pipeline. Store the token as a secret (e.g.{" "}
          <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>SENTRI_TOKEN</code>
          ) — never commit it directly.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Snippet label="GitHub Actions" code={ghActionsSnippet(projectId, apiBase)} />
          <Snippet label="GitLab CI" code={gitlabSnippet(projectId, apiBase)} />
          <Snippet label="cURL (direct)" code={curlSnippet(projectId, apiBase)} />
        </div>
      </div>

      {/* ── Polling reference ────────────────────────────────────────────── */}
      <div className="card card-padded" style={{ fontSize: "0.83rem", color: "var(--text2)" }}>
        <div className="trigger-section-title">How it works</div>
        <ol style={{ margin: "0 0 0 1.2em", padding: 0, lineHeight: 1.8 }}>
          <li>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>POST /trigger</code>
            {" "}returns <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>202 Accepted</code>
            {" "}immediately with <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>{"{ runId, statusUrl }"}</code>.
          </li>
          <li>Poll <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>statusUrl</code> until <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>status</code> is no longer <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>"running"</code>.</li>
          <li>A <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>status</code> of <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>"completed"</code> means all tests passed. Any other terminal value (<code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>"failed"</code>, <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>"aborted"</code>) means the run did not pass cleanly.</li>
          <li>Optionally pass <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>callbackUrl</code> in the request body to receive a POST with the summary when the run finishes.</li>
        </ol>
      </div>

    </div>
  );
}
