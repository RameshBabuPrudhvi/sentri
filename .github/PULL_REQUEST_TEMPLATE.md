## Summary

<!-- One paragraph. What does this PR change, at a high level? -->

## Motivation / Context

<!-- Why is this change needed? Link prior discussion, design docs, or incidents. -->

## Linked issue

Closes #<!-- issue number — PRs without a linked issue for non-trivial changes are closed -->

<!-- Depends on: #<PR-number> (delete if not applicable) -->

## Type of change

<!-- Tick all that apply. Aligns with Conventional Commits: https://www.conventionalcommits.org/ -->

- [ ] Bug fix (`fix:`)
- [ ] New feature (`feat:`, exists in ROADMAP.md)
- [ ] Breaking change (API, schema, or behavior incompatible with prior versions)
- [ ] Refactor / performance improvement (`refactor:` / `perf:`)
- [ ] Documentation / tests only (`docs:` / `test:`)
- [ ] Build / CI / chore (`build:` / `ci:` / `chore:`)
- [ ] Security fix

## How to test

<!-- Step-by-step instructions a reviewer can follow to verify this works. -->

1. <!-- step -->
2. <!-- step -->
3. <!-- step -->

## Screenshots / recordings (if UI changed)

<!-- Delete this section if not applicable. Provide before/after for visual changes. -->

| Before | After |
| --- | --- |
|        |       |

<!-- For interaction changes, attach a short screen recording (GIF / Loom). -->

## Risk & rollback

<!-- What's the blast radius if this goes wrong? How do we roll back? Delete if trivial. -->

## Reviewer notes

<!-- Optional: areas you'd like extra scrutiny on, known gaps, follow-ups. -->

## Checklist

<!-- Unchecked items are fine if they don't apply — leave a note explaining why. -->

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `perf:`, `docs:`, `refactor:`, `chore:`, etc.)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] New/modified backend logic has tests registered in `backend/tests/run-tests.js`
- [ ] `docs/changelog.md` updated under `## [Unreleased]` (user-visible changes only)
- [ ] `QA.md` walked for affected flows; Golden E2E re-run if core flow was touched
- [ ] `permissions.json` updated if a `requireRole()` gate was added/changed
- [ ] ROADMAP.md + NEXT.md updated if this closes a roadmap item (see REVIEW.md)
- [ ] UI changes meet accessibility requirements (keyboard nav, ARIA roles, color contrast)
- [ ] No secrets, API keys, or credentials in the diff
