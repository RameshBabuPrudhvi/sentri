/**
 * @module runner/recorderSetup
 * @description Reserved namespace for a future extraction of recorder
 * setup helpers shared between `startRecording` and `switchDevice` in
 * `recorder.js`.
 *
 * **CURRENT STATUS — empty placeholder.** The DIF-015c Gap 5 work in
 * PR #8 inlined the helper as `_attachAndOpenRecorderPage` /
 * `_finishOpenRecorderPage` inside `recorder.js` itself rather than
 * extract it to a separate module — the binding closure, pageAliases
 * map, and screencast handle would need to be threaded through a
 * shared options bag, which is more refactor than the PR's scope
 * supported.
 *
 * This file exists because an early Phase D edit created it as a
 * placeholder before the inline-helper approach was chosen. It is
 * intentionally non-functional (no exports) so importing it is a
 * no-op; bundlers will tree-shake it out of the final build.
 *
 * TODO(DIF-015c-FollowUp-1): delete this file or populate it with the
 *   shared setup helper. Tracked in ROADMAP.md under DIF-015c
 *   maintenance follow-ups. Until then, the duplicated binding setup
 *   in `recorder.js:_attachAndOpenRecorderPage` is "intentional, keep
 *   in sync" — see the file's own JSDoc for the maintenance contract.
 */
