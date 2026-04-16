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
        className="auto-card__header"
        onClick={() => setExpanded(e => !e)}
        style={{ padding: 0 }}
      >
        <Zap size={14} color="var(--accent)" />
        <span className="font-bold flex-1" style={{ fontSize: "0.95rem" }}>Integration Snippets</span>
        <ChevronDown size={14} color="var(--text3)" className="shrink-0"
          style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
      </button>

      {expanded && (
        <div style={{ marginTop: 18 }}>
          {/* Project selector */}
          <div className="flex-center gap-md mb-md">
            <label className="font-semi text-sub" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>
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

          <p className="text-sub" style={{ fontSize: "0.83rem", marginBottom: 20, marginTop: 0 }}>
            Use these in your CI pipeline. Store the token as a secret (e.g.{" "}
            <code className="text-mono text-xs">SENTRI_TOKEN</code>
            ) — never commit it directly.
          </p>

          <div className="flex-col gap-lg">
            <Snippet label="GitHub Actions" code={ghActionsSnippet(selectedId, apiBase)} />
            <Snippet label="GitLab CI" code={gitlabSnippet(selectedId, apiBase)} />
            <Snippet label="cURL (direct)" code={curlSnippet(selectedId, apiBase)} />
          </div>

          {/* How it works */}
          <div className="text-sub" style={{ fontSize: "0.83rem", marginTop: 24, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
            <div className="font-bold" style={{ marginBottom: 10 }}>How it works</div>
            <ol style={{ margin: "0 0 0 1.2em", padding: 0, lineHeight: 1.8 }}>
              <li>
                <code className="text-mono text-xs">POST /trigger</code>
                {" "}returns <code className="text-mono text-xs">202 Accepted</code>
                {" "}immediately with <code className="text-mono text-xs">{"{ runId, statusUrl }"}</code>.
              </li>
              <li>Poll <code className="text-mono text-xs">statusUrl</code> until <code className="text-mono text-xs">status</code> is no longer <code className="text-mono text-xs">"running"</code>.</li>
              <li>A <code className="text-mono text-xs">status</code> of <code className="text-mono text-xs">"completed"</code> means all tests passed. Any other terminal value (<code className="text-mono text-xs">"failed"</code>, <code className="text-mono text-xs">"aborted"</code>) means the run did not pass cleanly.</li>
              <li>Optionally pass <code className="text-mono text-xs">callbackUrl</code> in the request body to receive a POST with the summary when the run finishes.</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
