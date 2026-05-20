# Agent Roles (AI-004)

AI-004 introduces a **dormant** per-workspace agent-role configuration layer.

## Important behavior note

This release does **not** change runtime pipeline dispatch. The generation pipeline still uses the workspace default provider/model and built-in prompts. Agent-role config is stored/validated now so AI-005 can wire dispatch in a smaller follow-up PR.

## Canonical roles

The server only accepts these role names. Each maps to a single QA-domain
responsibility and produces one artifact, so multi-agent dispatch (AI-005)
can route work cleanly without overlap:

- `explorer` — crawls and classifies pages/states; output: state graph
- `planner` — decomposes goals into ordered test scenarios
- `author` — generates Playwright test code from scenarios
- `oracle` — generates and strengthens assertions (test oracle)
- `executor` — runs tests and captures traces/screencast/artifacts
- `healer` — repairs broken selectors and flows across runs
- `reviewer` — quality gate on generated tests (LLM-as-judge)
- `triager` — classifies failures (real bug / flake / env)

## Fields

Each workspace/role config can define:

- `provider` (nullable): null = workspace default provider
- `model` (nullable): null = provider default model
- `systemPromptOverride` (nullable, ≤ 32 000 chars): null = pipeline default prompt
- `temperature` (default `0.2`)
- `maxTokens` (nullable)
- `fallbackRole` (nullable)

## Validation rules

- Role names must be from the canonical allowlist.
- `fallbackRole` must also be canonical.
- `fallbackRole` graphs must be acyclic (e.g. `planner -> reviewer -> planner` is rejected).
- All reads/writes are workspace-scoped.

## UI path

`Settings → Agent Roles` (admin-only).

Use this screen to create, edit, and delete role configs. Because AI-004 is dormant, changing these values has no effect on current crawl/run behavior yet.
