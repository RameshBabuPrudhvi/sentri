/**
 * IntegrationCards — card grid showing CI/CD and notification integrations.
 *
 * "Connected" integrations (GitHub Actions, GitLab CI, cURL) link to the
 * snippet section below.  "Coming soon" integrations (Jenkins, Slack, Jira,
 * Azure DevOps) show a disabled connect button with a tooltip.
 *
 * @param {{ onScrollToSnippets?: () => void }} props
 */

import {
  Github, GitBranch, Terminal, MessageSquare,
  Plug, Cloud, CheckCircle2, ArrowRight,
} from "lucide-react";

// ─── Integration definitions ──────────────────────────────────────────────────

const INTEGRATIONS = [
  {
    id: "github-actions",
    name: "GitHub Actions",
    description: "Trigger regression runs on push, PR, or schedule via workflow YAML.",
    icon: Github,
    color: "var(--text)",
    bgColor: "var(--bg3)",
    status: "connected",
  },
  {
    id: "gitlab-ci",
    name: "GitLab CI",
    description: "Run Sentri tests in your .gitlab-ci.yml pipeline stages.",
    icon: GitBranch,
    color: "var(--amber)",
    bgColor: "var(--amber-bg)",
    status: "connected",
  },
  {
    id: "curl",
    name: "cURL / REST API",
    description: "Trigger runs from any CI system or script via the REST trigger endpoint.",
    icon: Terminal,
    color: "var(--green)",
    bgColor: "var(--green-bg)",
    status: "connected",
  },
  {
    id: "jenkins",
    name: "Jenkins",
    description: "Add a Sentri build step to your Jenkinsfile or freestyle project.",
    icon: Plug,
    color: "var(--blue)",
    bgColor: "var(--blue-bg)",
    status: "coming_soon",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Get real-time notifications in your Slack channel when runs complete or fail.",
    icon: MessageSquare,
    color: "var(--purple)",
    bgColor: "var(--purple-bg)",
    status: "coming_soon",
  },
  {
    id: "jira",
    name: "Jira",
    description: "Auto-create Jira issues for failed tests and link runs to tickets.",
    icon: Cloud,
    color: "var(--blue)",
    bgColor: "var(--blue-bg)",
    status: "coming_soon",
  },
  {
    id: "azure-devops",
    name: "Azure DevOps",
    description: "Integrate Sentri into your Azure Pipelines with a custom task.",
    icon: Cloud,
    color: "var(--accent)",
    bgColor: "var(--accent-bg)",
    status: "coming_soon",
  },
];

// ─── Single card ──────────────────────────────────────────────────────────────

function IntegrationCard({ integration, onScrollToSnippets }) {
  const Icon = integration.icon;
  const isConnected = integration.status === "connected";

  return (
    <div
      className="card auto-integ-card"
      style={{ cursor: isConnected ? "pointer" : "default" }}
      onClick={isConnected && onScrollToSnippets ? onScrollToSnippets : undefined}
      role={isConnected ? "button" : undefined}
      tabIndex={isConnected ? 0 : undefined}
      onKeyDown={isConnected && onScrollToSnippets ? (e) => { if (e.key === "Enter") onScrollToSnippets(); } : undefined}
    >
      {/* Icon + status */}
      <div className="flex-between">
        <div className="auto-integ-icon" style={{ background: integration.bgColor }}>
          <Icon size={18} color={integration.color} />
        </div>
        {isConnected ? (
          <span className="badge badge-green" style={{ gap: 3 }}>
            <CheckCircle2 size={10} /> Connected
          </span>
        ) : (
          <span className="badge badge-gray">Coming soon</span>
        )}
      </div>

      {/* Name + description */}
      <div>
        <div className="font-bold" style={{ fontSize: "0.88rem", marginBottom: 4 }}>
          {integration.name}
        </div>
        <div className="text-sub" style={{ fontSize: "0.78rem", lineHeight: 1.55 }}>
          {integration.description}
        </div>
      </div>

      {/* Action */}
      <div style={{ marginTop: "auto", paddingTop: 4 }}>
        {isConnected ? (
          <button
            className="btn btn-ghost btn-xs"
            style={{ gap: 4 }}
            onClick={(e) => { e.stopPropagation(); onScrollToSnippets?.(); }}
            tabIndex={-1}
          >
            View snippet <ArrowRight size={10} />
          </button>
        ) : (
          <button
            className="btn btn-ghost btn-xs"
            disabled
            title="This integration is not yet available"
          >
            <Plug size={10} /> Connect
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Grid ─────────────────────────────────────────────────────────────────────

export default function IntegrationCards({ onScrollToSnippets }) {
  return (
    <div className="card" style={{ padding: 24 }}>
      <div className="flex-center gap-sm mb-md">
        <Plug size={14} color="var(--accent)" />
        <span className="font-bold" style={{ fontSize: "0.95rem" }}>
          Integrations
        </span>
        <span className="text-xs text-muted" style={{ marginLeft: 4 }}>
          {INTEGRATIONS.filter(i => i.status === "connected").length} connected
        </span>
      </div>
      <div className="auto-integ-grid">
        {INTEGRATIONS.map(i => (
          <IntegrationCard
            key={i.id}
            integration={i}
            onScrollToSnippets={onScrollToSnippets}
          />
        ))}
      </div>
    </div>
  );
}
