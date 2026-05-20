# Multi-agent pipeline (AI-005)

Sentri's test-generation pipeline runs in **eight stages** (crawl
classification → scenario planning → code generation → critic review →
self-healing). Each stage calls a single LLM. By default every stage uses the
same provider — fine for trial and small teams.

**AI-005 (multi-agent dispatch)** lets you assign a different provider /
model / system prompt to each stage, so you can pick the best model for each
job: cheap + fast for crawl classification, top-tier for code generation,
independent model for the critic, on-prem Ollama for healing.

Multi-agent mode is **off by default** and **fully backwards compatible**.
Workspaces with no `agent_configs` rows behave identically to single-agent
mode — same provider, same prompt, same cost.

---

## Single vs multi-agent mode

| Mode | Trigger | Cost | Best for |
|---|---|---|---|
| **Single** | No rows in `agent_configs` for the workspace | 1 provider × 8 stages | Trial, hobby, single-LLM contracts |
| **Multi** | At least one role configured per pipeline stage you want to route | Variable — different providers per stage | Production SaaS, cost optimisation, second-opinion critics |

Sentri picks single mode automatically when the workspace has no agent
configs. Adding a row for a role lights that stage up; unconfigured stages
keep using the workspace default.

---

## Canonical agent roles

| Role | Pipeline stage | Recommended model |
|---|---|---|
| `explorer` | Crawl classification (`crawler.js` → `classifyPageWithAI`) | Cheap + fast (GPT-4o-mini, Gemini Flash) |
| `planner` | Scenario / journey planning (`journeyGenerator.generateJourneyTest`) | Strong reasoning (Claude Sonnet, GPT-4o) |
| `author` | Code generation + refinement + chat (`journeyGenerator.generateIntentTests`, `feedbackLoop`, `chat.js`) | Best at structured output (Claude Sonnet) |
| `oracle` | Assertion strengthening (planned, AUTO-023) | Strong reasoning |
| `reviewer` | Critic review (planned, AUTO-023) | Different model from `author` for an independent second opinion |
| `healer` | Self-healing (DOM + vision, planned full plumbing) | Low-stakes — Ollama or Gemini Flash |
| `triager` | Failure clustering (planned, AUTO-021) | Cheap + fast |
| `default` | Catch-all metric label for unscoped calls | — |

> The role names above are the bounded cardinality set the Prometheus
> `agent_role` label can take. Adding a new role requires editing
> `backend/src/aiProvider/agentHealthCheck.js#AGENT_ROLES` first.

---

## Recommended role → provider matchups

These are starting points — A/B test against your eval harness
(`AUTO-022`) before promoting to production.

| Workload | Suggested matrix |
|---|---|
| **Cost-optimised** | explorer=`gpt-4o-mini`, planner=`claude-sonnet-4`, author=`claude-sonnet-4`, healer=`ollama:mistral` |
| **Multi-vendor (avoid lock-in)** | explorer=`openai`, planner=`anthropic`, reviewer=`google`, healer=`ollama` |
| **Independent critic** | author=`claude-sonnet-4`, reviewer=`gpt-4o` (different vendor → independent opinion) |
| **On-prem critical path** | every role → `ollama:llama3:8b` (no data leaves the cluster) |

---

## Configuring agents

Per-workspace agent rows live in the `agent_configs` table. Every row carries:

```text
id, workspaceId, role, provider, model, systemPromptOverride,
temperature, maxTokens, fallbackRole, createdAt, updatedAt
```

`UNIQUE(workspaceId, role)` is enforced — one row per role per workspace.

Edit via **Settings → Agents** (admin only). The UI surfaces:

- Provider dropdown (one of the providers configured under Settings →
  AI Provider — cloud key, Ollama, or any OpenAI-compatible slot).
- Model field (free text, validated against the catalog when known).
- System prompt override (free text, optional — appended as the system
  message at every call site for this role).
- Max tokens (optional; falls back to caller's hint or `LLM_MAX_TOKENS`).
- Fallback role (drop-down of other roles — if this role's provider is
  rate-limited, dispatch falls through to the fallback role's provider).

### `fallbackRole` cycle protection

A `fallbackRole` chain that revisits its own starting role is rejected at
save time with HTTP 400 (`ERR_AGENT_FALLBACK_CYCLE`). This means you cannot
configure `planner.fallbackRole = critic` while `critic.fallbackRole =
planner` — pick one direction or remove the loop.

---

## Pre-run agent health check

Before any crawl + AI run starts, Sentri probes every configured
`(workspaceId, role)` pair with a one-token throwaway call. The run **fails
fast at minute 0** rather than at minute 9 if a misconfigured role has a
bad API key.

Failures surface in the run log:

```text
Agent health check failed — Agent health check failed: critic=401, planner=ok
   • critic (anthropic) → 401
```

and as `ERR_AGENT_HEALTH_CHECK_FAILED` on the run status. The probe is
skipped automatically when the workspace has no agent configs.

You can also re-run the probe for one role on demand from **Settings →
Agents → Test** — it returns `{ ok, reason, provider }` and shows a green /
red badge inline.

---

## Cost implications

Multi-agent dispatch can **lower** total cost (cheap explorer / healer)
but also **raise** it (top-tier model on every stage where you used a
cheap one before). Track per-role spend via the new `agent_role` label on
the four AI Prometheus counters:

```promql
sum by (agent_role) (rate(app_ai_cost_usd_total[1h]))
```

The cardinality is bounded: 8 canonical roles × 5 provider labels × 3
outcomes = 120 series per metric, well under Prometheus's 10k/metric
recommended ceiling.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Run fails immediately with `ERR_AGENT_HEALTH_CHECK_FAILED` | One configured role has a bad key or unreachable provider | Click **Settings → Agents → Test** to identify which role; rotate / fix the key |
| Specific stage keeps using the workspace default despite an agent_config row | Sticky fallback active for that role (rate-limit recovery) | Wait `STICKY_FALLBACK_TTL_MS` (default 10 min) or rotate the upstream key |
| `fallbackRole` save returns 400 | Cycle detected (`ERR_AGENT_FALLBACK_CYCLE`) | Break the loop — set one role's `fallbackRole` to `null` |
| Metrics for one role missing in Grafana | Pipeline caller for that stage doesn't pass `agentRole` yet | Check `selfHealing.js` / `failureClusterer.js` — full plumbing tracked under AUTO-023 |
| `default` label dominates `app_ai_cost_usd_total` | Most call sites still call `generateText()` without `agentRole` | Expected on single-agent installations — the `"default"` bucket is the catch-all |

---

## Roadmap

This page covers the **AI-005 foundation** shipped in PR #22 (per-role
provider routing, per-role circuit breakers, per-role metrics, fallbackRole
cycle guard, pre-flight health check).

The structured **agent handshake envelope** (`{ fromRole, toRole, artifact,
traceId }`) and the **DAG runner** that lets the planner's output flow into
the author's prompt land in **AUTO-023**. Per-`(workspace, role)` API keys
land in **AI-005b**. See `ROADMAP.md` for sequencing.
