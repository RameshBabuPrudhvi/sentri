# Contributing to Sentri

Thank you for your interest in contributing. This document explains how to contribute meaningfully and what will get a PR closed without review.

---

## Before you open anything

- **Search first.** Check [open issues](https://github.com/RameshBabuPrudhvi/sentri/issues), [open PRs](https://github.com/RameshBabuPrudhvi/sentri/pulls), and [ROADMAP.md](ROADMAP.md) before starting work. Duplicate PRs are closed immediately.
- **Open an issue before a PR** for any non-trivial change — new features, architectural changes, or anything that touches more than one subsystem. This avoids wasted effort if the direction isn't right.
- **Read the key docs.** [AGENTS.md](AGENTS.md) covers architecture and hard DO NOTs. [STANDARDS.md](STANDARDS.md) covers code conventions. [REVIEW.md](REVIEW.md) is the PR checklist you'll be held to.

---

## What we welcome

- Bug fixes with a clear reproduction case
- Performance improvements with measurable evidence
- Features that appear in [ROADMAP.md](ROADMAP.md) and have no open PR already
- Documentation improvements that correct errors or fill genuine gaps
- Tests that cover untested paths in existing logic

---

## What will be closed without review

We receive a high volume of low-effort PRs. The following are closed immediately, no exceptions:

| Type | Why |
|---|---|
| Reformatting / whitespace-only | No functional value |
| Renaming variables to synonyms | No functional value |
| Adding comments that restate the code | No functional value |
| README badge additions | Unsolicited and out of scope |
| Dependency bumps not tracked in `renovate.json` | Renovate handles this automatically |
| PRs with no linked issue for non-trivial changes | Undiscussed work is unreviewed work |
| PRs that fail CI | Fix CI before opening |
| AI-generated PRs with no human review | Obvious from diff quality; closed on sight |
| Typo fixes in non-user-facing strings | Very low value; batch them if at all |

If your PR is closed for one of these reasons, it is not personal — it is a policy applied consistently.

---

## Development setup

```bash
git clone https://github.com/RameshBabuPrudhvi/sentri.git
cd sentri

cp backend/.env.example backend/.env
# Add at least one AI provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, etc.)

docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000).

For full local dev (without Docker), see the [Getting Started guide](https://rameshbabuprudhvi.github.io/sentri/docs/guide/getting-started.html).

---

## Workflow

1. **Fork** the repository.
2. **Create a branch** from `develop` (not `main`):
   - Features: `feature/<short-description>`
   - Fixes: `fix/<short-description>`
3. **Make your changes.** Follow [STANDARDS.md](STANDARDS.md) throughout.
4. **Write tests.** Every PR that adds or modifies backend logic must include tests registered in `backend/tests/run-tests.js`. PRs without adequate coverage are not merged.
5. **Run CI locally** before pushing:
   ```bash
   cd backend && npm test
   cd frontend && npm run build && npm test
   ```
6. **Update the changelog.** Add an entry under `## [Unreleased]` in `docs/changelog.md` for any user-visible change.
7. **Walk QA.md.** For changes that touch the core flow (auth → project → crawl → generate → approve → run → heal), run the Golden E2E Happy Path on Chromium plus one other browser.
8. **Open the PR** against `develop`.

---

## Commit and PR title format

This project uses [Conventional Commits](https://www.conventionalcommits.org/). The release pipeline reads commit messages to determine version bumps — malformed titles break automation.

```
feat: add flaky test export to CSV
fix: correct selector waterfall fallback order
docs: clarify env var for Ollama provider
perf: reduce redundant DB queries in runRepo
feat!: remove legacy v1 webhook format (breaking change)
```

**PR titles must follow the same format.** A PR titled "update stuff" or "fixes" will be asked to rename before review begins.

---

## Code standards (summary)

Full rules are in [STANDARDS.md](STANDARDS.md). The most commonly violated ones:

- **Backend**: Node.js 20+, ES Modules only — `import`/`export`, never `require()`. All imports use explicit `.js` extensions.
- **Frontend**: React 18, plain JSX, no TypeScript, Vite 6. CSS via custom properties in `tokens.css` — no Tailwind, no CSS-in-JS.
- **JSDoc**: Every exported backend function needs `@module`, `@param`, `@returns`, and `@throws` where applicable. Use JSDoc syntax, not TypeScript syntax — the CI JSDoc build will fail on `?` optionals and inline record types.
- **Naming**: `camelCase.js` for backend modules, `PascalCase.jsx` for React components/pages, `useNoun.js` for hooks, `kebab-case.css` for stylesheets.
- **No shared helpers duplicated inline.** New utilities go in `utils/`, not in the file that first needs them.
- **No orphan backend routes (PROC-001).** Every new `router.<method>(…)` in `backend/src/routes/*.js` must ship its frontend consumer in the same PR — a helper added to `frontend/src/api.js` plus a callsite in `frontend/src/pages/*.jsx` or `frontend/src/components/**/*.jsx`. API-without-UI PRs are closed. Opt out for genuinely UI-less endpoints (internal admin, healthchecks, machine-only triggers) by adding `[no-ui]` to the PR title; the `.github/workflows/no-orphan-routes.yml` guard enforces this.

---

## Security-sensitive changes

PRs that touch auth, routing, RBAC, or data handling require extra scrutiny. Before opening:

- Review the security checklist in [REVIEW.md](REVIEW.md).
- Update `backend/src/middleware/permissions.json` if you add, remove, or change a `requireRole(...)` gate.
- Do not introduce new environment variables without updating `docs/guide/env-vars.md`.

---

## Roadmap items

If you want to implement something from [ROADMAP.md](ROADMAP.md):

1. Comment on the roadmap issue (or open one) to claim the item. This prevents two people doing the same work.
2. Follow the sprint tracker hand-off in [REVIEW.md](REVIEW.md) — update `NEXT.md` and `ROADMAP.md` when your PR ships.

---

## PR review expectations

- Maintainers aim to triage new PRs within **5 business days**. No response within that window is not an invitation to ping repeatedly.
- Requested changes must be addressed within **14 days** or the PR may be closed to keep the queue clean. It can be reopened once the changes are made.
- One approval from a maintainer is required to merge. The CI pipeline (Gitleaks → backend tests → frontend build/test → docs → Docker smoke) must be fully green.

---

## Questions

Open a [GitHub Discussion](https://github.com/RameshBabuPrudhvi/sentri/discussions) for usage questions or design conversations. Issues are for bugs and concrete feature requests only.
