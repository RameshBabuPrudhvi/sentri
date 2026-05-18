# AUTO-022 — Eval golden-set fixtures

This directory holds the `case-NNN.json` golden cases consumed by the
AUTO-022 AI eval harness. See **[`docs/guide/eval-harness.md`](../../../../docs/guide/eval-harness.md)**
for the schema, authoring workflow, baseline-update procedure, and CI
behaviour.

Quick orientation:

- `case-001.json` … `case-005.json` — canonical templates (one per category).
- `snapshots/` — large DOM captures referenced via `@file:snapshots/<id>.html`.
- `.cache/` — git-ignored local LLM response cache (record/replay).
