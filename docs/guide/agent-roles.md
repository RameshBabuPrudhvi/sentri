# Agent Roles (AI-004)

AI-004 introduces a **dormant** per-workspace agent-role configuration layer.

## Important behavior note

This release does **not** change runtime pipeline dispatch. The generation pipeline still uses the workspace default provider/model and built-in prompts. Agent-role config is stored/validated now so AI-005 can wire dispatch in a smaller follow-up PR.

## Canonical roles

The server only accepts these role names:

- `planner`
- `codegen`
- `critic`
- `selfheal`
- `crawl_classify`
- `scenario_plan`
- `assertion_enhance`
- `state_explorer`

## Fields

Each workspace/role config can define:

- `provider` (nullable): null = workspace default provider
- `model` (nullable): null = provider default model
- `systemPromptOverride` (nullable): null = pipeline default prompt
- `temperature` (default `0.2`)
- `maxTokens` (nullable)
- `fallbackRole` (nullable)

## Validation rules

- Role names must be from the canonical allowlist.
- `fallbackRole` must also be canonical.
- `fallbackRole` graphs must be acyclic (e.g. `planner -> critic -> planner` is rejected).
- All reads/writes are workspace-scoped.

## UI path

`Settings → Agent Roles` (admin-only).

Use this screen to create, edit, and delete role configs. Because AI-004 is dormant, changing these values has no effect on current crawl/run behavior yet.
