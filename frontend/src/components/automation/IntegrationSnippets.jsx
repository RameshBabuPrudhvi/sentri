/**
 * IntegrationSnippets — CI/CD integration code snippets with project selector.
 *
 * Renders copy-to-clipboard YAML/bash snippets for GitHub Actions, GitLab CI,
 * and cURL. A project selector dropdown fills in the projectId placeholder.
 *
 * @param {{ projects: Array<{id: string, name: string}>, defaultProjectId?: string }} props
 */

import { useState } from "react";
import { Zap, ChevronDown } from "lucide-react";
import CopyButton from "../shared/CopyButton.jsx";

// ─── Snippet builders ─────────────────────────────────────────────────────────

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
            status=$(curl -sf \\
              -H "Authorization: Bearer \${{ secrets.SENTRI_TOKEN }}" \\
              "$status_url" | jq -r .status)
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
        STATUS=$(curl -sf \\
          -H "Authorization: Bearer $SENTRI_TOKEN" \\
          "$STATUS_URL" | jq -r .status)
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

// ─── Snippet block ────────────────────────────────────────────────────────────

function Snippet({ label, code }) {
  return (
    <div className="auto-snippet">
      <div className="auto-snippet__label">{label}</div>
      <pre>{code}</pre>
      <div className="auto-snippet__copy">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function IntegrationSnippets({ projects, defaultProjectId }) {
  const [selectedId, setSelectedId] = useState(defaultProjectId || projects[0]?.id || "");
  const [expanded, setExpanded] = useState(false);

  const apiBase = typeof window !== "undefined" ? window.location.origin : "";

  if (!projects.length) return null;

  return (
    <div className="card" style={{ padding: 24 }}>
      {/* Header — clickable to expand/collapse */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          background: "none", border: "none", cursor: "pointer", padding: 0,
          color: "var(--text)", fontWeight: 700, fontSize: "0.95rem",
        }}
      >
        <Zap size={14} color="var(--accent)" />
        Integration Snippets
        <ChevronDown size={14} color="var(--text3)"
          style={{ marginLeft: "auto", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
      </button>

      {expanded && (
        <div style={{ marginTop: 18 }}>
          {/* Project selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
            <label style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text2)", whiteSpace: "nowrap" }}>
              Project:
            </label>
            <select
              className="input"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              style={{ maxWidth: 280, height: 34, fontSize: "0.82rem" }}
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
              ))}
            </select>
          </div>

          <p style={{ fontSize: "0.83rem", color: "var(--text2)", marginBottom: 20, marginTop: 0 }}>
            Use these in your CI pipeline. Store the token as a secret (e.g.{" "}
            <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>SENTRI_TOKEN</code>
            ) — never commit it directly.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Snippet label="GitHub Actions" code={ghActionsSnippet(selectedId, apiBase)} />
            <Snippet label="GitLab CI" code={gitlabSnippet(selectedId, apiBase)} />
            <Snippet label="cURL (direct)" code={curlSnippet(selectedId, apiBase)} />
          </div>

          {/* How it works */}
          <div style={{ fontSize: "0.83rem", color: "var(--text2)", marginTop: 24, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>How it works</div>
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
      )}
    </div>
  );
}
