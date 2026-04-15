/**
 * TokenManager — per-project CI/CD trigger token CRUD (ENH-011).
 *
 * Extracted from TriggerTab for reuse in the Automation page.
 * Handles token creation (with one-time plaintext reveal), listing,
 * and revocation.
 *
 * @param {{ projectId: string }} props
 */

import { useState, useEffect, useCallback } from "react";
import { Copy, Check, Plus, Trash2 } from "lucide-react";
import { api } from "../../api.js";

// ─── Small helpers ─────────────────────────────────────────────────────────────

function CopyButton({ text, className = "btn btn-ghost btn-xs" }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard unavailable (non-HTTPS, denied permission) */ });
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function TokenManager({ projectId }) {
  const [tokens, setTokens]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [creating, setCreating]     = useState(false);
  const [label, setLabel]           = useState("");
  const [newToken, setNewToken]     = useState(null); // plaintext reveal
  const [revoking, setRevoking]     = useState(null); // tokenId being deleted
  const [error, setError]           = useState(null);

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
      if (newToken) setNewToken(null);
    } catch {
      setError("Failed to revoke token.");
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div>
      {/* One-time reveal */}
      {newToken && (
        <TokenReveal token={newToken} onDismiss={() => setNewToken(null)} />
      )}

      {/* Error banner */}
      {error && (
        <div className="banner banner-error" style={{ marginBottom: 12 }}>
          {error}
          <button className="btn btn-ghost btn-xs" style={{ marginLeft: "auto" }}
            onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Create form */}
      <form onSubmit={handleCreate}
        style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
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
  );
}
