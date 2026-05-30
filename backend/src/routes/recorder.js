/**
 * @module routes/recorder
 * @description DIF-015 — Interactive browser recorder. Mounted at `/api/v1`
 * (INF-005). Extracted from `routes/tests.js` (MNT decomposition).
 *
 * Opens a Playwright browser at the project URL, streams the live CDP
 * screencast to the RecorderModal (via SSE on the session ID), and
 * captures raw user interactions. On stop, the captured actions are
 * transformed into a Playwright test body and saved as a Draft test.
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import { generateTestId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { actor } from "../utils/actor.js";
import { resolveEnvOrThrow } from "../utils/routeHelpers.js";
import { requireRole } from "../middleware/requireRole.js";
import { expensiveOpLimiter } from "../middleware/appSetup.js";
import { DEVICE_PRESETS, VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from "../runner/config.js";
import {
  startRecording,
  stopRecording,
  getRecording,
  takeCompletedRecording,
  actionsToPlaywrightCode,
  forwardInput,
  recordedActionToStepText,
  addAssertionAction,
  filterEmittableActions,
  pauseRecording,
  resumeRecording,
  popLastRecordingAction,
  switchDevice,
  probeAtPoint,
} from "../runner/recorder.js";

/**
 * DIF-015c Gap 5 — allowlist of device names accepted at the route
 * layer. Built once at module load from the same `DEVICE_PRESETS` the
 * `RunRegressionModal` dropdown surfaces, so the recorder's accepted
 * inputs stay byte-aligned with the rest of the regression suite.
 */
const RECORDER_DEVICE_VALUES = new Set(DEVICE_PRESETS.map((d) => d.value));

/**
 * Return `desiredName` if it's free within the project, otherwise append
 * ` (2)`, ` (3)`, … until a non-colliding name is found. Compares
 * case-insensitively (manual testers expect "Login" and "login" to be
 * treated as the same name) and ignores soft-deleted tests because
 * `testRepo.getByProjectId()` already filters them out.
 *
 * Used by the recorder stop handler so two recordings saved with the same
 * name (or two no-name saves whose default ISO-timestamp collides at the
 * same millisecond) don't produce two indistinguishable rows in the Tests
 * list. Also covers the MAX_RECORDING_MS auto-timeout recovery branch —
 * both paths funnel through `dedupeTestName`.
 *
 * Hot-path consideration: `getByProjectId` does one indexed
 * `SELECT * WHERE projectId = ?`. Recorder stop is a low-frequency event
 * (one per user save), so the in-process scan is fine — we don't want to
 * add a `(projectId, name)` UNIQUE index because the AI pipeline already
 * suffixes its own names and adding a hard constraint would break
 * legacy rows where duplicates already exist.
 *
 * @param {string} projectId
 * @param {string} desiredName
 * @returns {string} A name that doesn't collide with any existing test.
 */
function dedupeTestName(projectId, desiredName) {
  const base = String(desiredName || "").trim();
  if (!base) return base; // caller is responsible for never passing empty
  const existing = testRepo.getByProjectId(projectId);
  const taken = new Set(existing.map((t) => String(t.name || "").trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  // Walk suffix counters until we find a free slot. Cap at 999 to avoid an
  // infinite loop on a pathological project — beyond that, fall through to
  // the timestamped form which is effectively guaranteed unique.
  for (let i = 2; i <= 999; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${new Date().toISOString()})`;
}

const router = Router();

/**
 * POST /api/v1/projects/:id/record
 * Body: { startUrl?: string } — defaults to the project URL.
 *
 * Returns { sessionId } — the SSE run ID the frontend should subscribe to
 * for live screencast frames while recording.
 */
router.post("/projects/:id/record", requireRole("qa_lead"), expensiveOpLimiter, async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  // DIF-012: optional per-session environment override. The recorder is
  // driven interactively by the operator (no auto-login), so the env only
  // affects the default `startUrl` — if the caller didn't supply one, fall
  // back to `environment.baseUrl` instead of `project.url` so the operator
  // lands on the right environment from the first frame.
  let environment;
  try {
    environment = resolveEnvOrThrow(req.body?.environmentId, project);
  } catch (err) {
    return res.status(err.httpStatus || 400).json({ error: err.message });
  }

  const startUrl = String(req.body?.startUrl || environment?.baseUrl || project.url || "").trim();
  if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    return res.status(400).json({ error: "startUrl must be a valid http(s) URL" });
  }

  // DIF-015c Gap 5: validate the optional device profile UP-FRONT, before
  // `runRepo.create()` inserts the stub `running` row below. A 400 return
  // after the row was created would orphan it — the partial unique index
  // `idx_runs_one_active_per_project` would then block every subsequent
  // run (crawl, test_run, generate, record) on this project until the next
  // recorder-launch orphan sweep. Hoist the check alongside `startUrl`
  // validation so all input rejection happens before any DB side effects.
  const rawDevice = req.body?.device;
  const device = rawDevice == null ? "" : String(rawDevice);
  if (device && !RECORDER_DEVICE_VALUES.has(device)) {
    return res.status(400).json({ error: `Invalid device: ${device}` });
  }
  // DIF-015c Gap 6: optional stealth profile. Coerce to a strict
  // boolean so a stringy `"true"` payload from a misconfigured client
  // doesn't accidentally enable stealth (or vice versa). Only the
  // literal JSON `true` opts in — every other value (false, null,
  // omitted, "true", 1) leaves stealth off so default-mode runs are
  // bit-for-bit unchanged.
  const stealth = req.body?.stealth === true;

  const sessionId = `REC-${randomUUID().slice(0, 8)}`;
  // Visible breadcrumb so the operator can see the recorder reaching the
  // backend even when everything is working — useful for debugging the
  // "canvas stays black" symptom where the request landed but a downstream
  // step (browser launch, screencast attach) silently fails.
  console.log(formatLogLine("info", null, `[recorder] launching session=${sessionId} project=${project.id} url=${startUrl}`));
  try {
    // Defence-in-depth: the partial unique index `idx_runs_one_active_per_project`
    // (migration 002) allows at most one `running` run per project. If a
    // previous recorder attempt crashed between `runRepo.create` and the
    // rollback below, an orphan row blocks every subsequent recorder launch
    // with a UNIQUE constraint error. Sweep any such orphans for THIS
    // project before inserting the new stub so the user isn't permanently
    // locked out of the recorder.
    try {
      // Only sweep orphaned RECORDER rows. Including crawl/test_run/generate
      // here would silently kill a legitimately in-progress regression or
      // crawl run when the user opens the recorder, leading to data loss
      // (the runner process keeps executing in memory unaware that its DB
      // status was overwritten). The partial unique index allows one active
      // run per project across all types — so a concurrent recorder + run is
      // intentionally not supported, and the create() below will surface a
      // UNIQUE constraint error that the outer catch handles cleanly.
      const orphan = runRepo.findActiveByProjectId(project.id, ["record"]);
      if (orphan) {
        runRepo.update(orphan.id, {
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          error: "Cleared by recorder launch — previous recording session was orphaned",
        });
      }
    } catch (sweepErr) {
      // Non-fatal: log and continue. If the orphan really exists the create
      // below will surface the UNIQUE error and the catch handles it.
      console.warn(formatLogLine("warn", null, `[POST projects/${project.id}/record] orphan sweep failed: ${sweepErr.message}`));
    }

    // The frontend opens an SSE stream at /runs/:sessionId/events to receive
    // live screencast frames. That endpoint validates the runId against the
    // `runs` table — without a stub row here the SSE connection 404s and the
    // canvas stays black ("Waiting for browser stream…"). Create a minimal
    // running-row keyed by sessionId so SSE accepts it; stopRecording marks
    // it completed so orphan recovery doesn't flag it as interrupted.
    runRepo.create({
      id: sessionId,
      projectId: project.id,
      type: "record",
      status: "running",
      startedAt: new Date().toISOString(),
      // Persist the starting URL so the Recorder modal's start-URL dropdown
      // (`GET /api/v1/projects/:id/pages`) can surface URLs from past
      // recordings as suggestions for new recordings on the same project.
      // The `runs` table has no dedicated `url` column, but `pages` is a
      // JSON column already used by the crawler to persist discovered URLs
      // — reuse it here with a single `{url, status: "recorded"}` entry so
      // the same /pages aggregator works for both crawl + record sources.
      pages: [{ url: startUrl, title: startUrl, status: "recorded" }],
      workspaceId: project.workspaceId || null,
      // DIF-012: record which environment (if any) the operator picked at
      // session start, for audit consistency with crawl/run/generate paths.
      environmentId: environment?.id || null,
    });
    // `device` + `stealth` were validated/coerced BEFORE `runRepo.create()`
    // above so an invalid payload doesn't orphan a stub `running` row.
    await startRecording({ sessionId, projectId: project.id, startUrl, device, stealth });
    console.log(formatLogLine("info", null, `[recorder] session=${sessionId} ready — browser launched, screencast attached`));
    logActivity({ ...actor(req),
      type: "test.record_start", projectId: project.id, projectName: project.name,
      detail: `Recorder started on ${startUrl}`, status: "running",
    });
    // Return the server-side viewport so the frontend can scale forwarded
    // pointer coordinates correctly on deployments that override the default
    // 1280x720 via VIEWPORT_WIDTH / VIEWPORT_HEIGHT env vars, OR — DIF-015c
    // Gap 5 — when a Playwright device descriptor (e.g. iPhone 14 = 390×844)
    // overrides the desktop default. Read the resolved viewport off the
    // session we just created so the canvas sizes correctly on the first
    // SSE frame.
    const sess = getRecording(sessionId);
    const resolvedViewport = sess?.viewport || { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
    res.status(202).json({
      sessionId,
      startUrl,
      device: sess?.device || "",
      // DIF-015c Gap 6: surface the resolved stealth flag so the
      // frontend can reflect the active state in the recording-stage
      // sidebar (and so an operator who toggled stealth but hit a
      // server-side error sees an explicit `stealth: false` rather
      // than guessing from missing UI).
      stealth: sess?.stealth === true,
      viewport: resolvedViewport,
    });
  } catch (err) {
    // Roll back the stub row so a failed launch doesn't leave an orphaned
    // "running" record that blocks future recordings or trips orphan recovery.
    try { runRepo.update(sessionId, { status: "failed", finishedAt: new Date().toISOString(), error: err.message }); } catch { /* row may not exist */ }
    console.error(formatLogLine("error", null, `[POST projects/${project.id}/record] startRecording failed: ${err.message}`));
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/stop
 * Body: { name: string } — the name to give the recorded Draft test.
 *
 * Persists the recorded actions as a new Draft test containing the
 * generated Playwright code. Returns the created test.
 */
router.post("/projects/:id/record/:sessionId/stop", requireRole("qa_lead"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const sess = getRecording(req.params.sessionId);
  // When the `MAX_RECORDING_MS` safety-net timeout has already torn the
  // session down, `getRecording` returns null but the generated test may
  // still be waiting in the short-lived completed-recordings cache. Fall
  // back to that cache so the user doesn't lose their captured actions to
  // a race with the auto-teardown.
  let autoCompleted = null;
  if (!sess) {
    autoCompleted = takeCompletedRecording(req.params.sessionId);
    if (!autoCompleted || autoCompleted.projectId !== project.id) {
      return res.status(404).json({ error: "recording session not found" });
    }
  } else if (sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }

  // `discard: true` tears down the browser without persisting a Draft test.
  // Used by the RecorderModal's Cancel/Discard button so abandoned recordings
  // do not leave junk tests in the DB.
  const discard = req.body?.discard === true;
  const name = String(req.body?.name || "").trim() || `Recorded flow @ ${new Date().toISOString()}`;

  let stopResult;
  let recoveredFromAutoTimeout = false;
  if (autoCompleted) {
    // Session was already torn down by the auto-timeout; regenerate the
    // Playwright body with the requested test name (the cached code was
    // generated with a default name).
    const playwrightCode = actionsToPlaywrightCode(name, autoCompleted.url, autoCompleted.actions);
    stopResult = { actions: autoCompleted.actions, playwrightCode, url: autoCompleted.url };
    recoveredFromAutoTimeout = true;
  } else {
    try {
      stopResult = await stopRecording(req.params.sessionId, { testName: name });
    } catch (err) {
      // Race window between the `getRecording()` guard above and
      // `stopRecording()` — the MAX_RECORDING_MS timeout may have fired in
      // the interim. Try the completed-recordings cache one more time.
      if (/not found/i.test(err.message || "")) {
        const cached = takeCompletedRecording(req.params.sessionId);
        if (cached && cached.projectId === project.id) {
          const playwrightCode = actionsToPlaywrightCode(name, cached.url, cached.actions);
          stopResult = { actions: cached.actions, playwrightCode, url: cached.url };
          recoveredFromAutoTimeout = true;
        }
      }
      if (!stopResult) {
        // Discard is a best-effort cleanup path: if the session is already
        // gone and we have nothing cached, the caller's intent (close the
        // browser, don't persist a test) is already satisfied.
        if (discard && /not found/i.test(err.message || "")) {
          logActivity({ ...actor(req),
            type: "test.record_discard", projectId: project.id, projectName: project.name,
            detail: `Recording discarded after session auto-teardown (${req.params.sessionId})`, status: "success",
          });
          return res.json({ ok: true, discarded: true, alreadyStopped: true });
        }
        console.error(formatLogLine("error", null, `[POST record/${req.params.sessionId}/stop] stopRecording failed: ${err.message}`));
        return res.status(500).json({ error: "Internal server error" });
      }
    }
  }

  // Close out the stub `runs` row created by POST /record so the SSE channel
  // releases its listener and orphan recovery doesn't pick this up later.
  // Also update `pages` to the actual landed URL — the stub row created by
  // POST /record persisted the caller-supplied `startUrl` (pre-redirect),
  // but `startRecording` resolved it to `stopResult.url` after any
  // server-side redirects. Without this update, the Recorder Start-URL
  // dropdown (`GET /api/v1/projects/:id/pages`) would surface the
  // pre-redirect URL on every subsequent recording launch, causing an
  // unnecessary redirect each time (http→https, apex→www, OAuth callbacks).
  try {
    runRepo.update(req.params.sessionId, {
      status: "completed",
      finishedAt: new Date().toISOString(),
      pages: [{ url: stopResult.url, title: stopResult.url, status: "recorded" }],
    });
  } catch { /* row may have been cleaned up already */ }

  if (discard) {
    logActivity({ ...actor(req),
      type: "test.record_discard", projectId: project.id, projectName: project.name,
      detail: `Recording discarded (${stopResult.actions?.length || 0} actions dropped)`, status: "success",
    });
    return res.json({ ok: true, discarded: true, ...(recoveredFromAutoTimeout ? { alreadyStopped: true } : {}) });
  }

  if (!stopResult.actions || stopResult.actions.length === 0) {
    return res.status(400).json({ error: "no actions were captured — nothing to save" });
  }

  // Dedupe consecutive `goto` actions to the same URL before formatting steps.
  // `startRecording` always pushes the initial `{ kind: "goto", url: startUrl }`
  // as actions[0], and the page's `framenavigated` listener echoes another
  // `goto` for the resolved URL right after. Without this filter the Test
  // Details page shows two redundant navigation steps for what is really a
  // single navigation.
  //
  // Match `actionsToPlaywrightCode`'s exact-URL comparison so the persisted
  // human-readable `steps[]` array and the generated `playwrightCode` stay
  // in lock-step — they are rendered side-by-side on the Test Detail page,
  // and any drift in step count between the two is immediately visible to
  // reviewers (and breaks step-based edits/regeneration that index by
  // position). Origin+pathname dedup would silently drop legitimate
  // query-distinct navigations (e.g. `/search?q=iphone` → `/search?q=macbook`,
  // pagination via `?page=N`, OAuth redirects with state tokens), which
  // matters for any flow that exercises query-driven UI state.
  const dedupedActions = [];
  let lastGotoUrl = String(stopResult.url || "");
  for (const a of stopResult.actions) {
    if (a.kind === "goto" && a.url) {
      if (a.url === lastGotoUrl) continue;
      lastGotoUrl = a.url;
    }
    dedupedActions.push(a);
  }

  // Drop actions that `actionsToPlaywrightCode` would silently skip due to
  // missing required fields. `filterEmittableActions` is the shared predicate
  // exported by the recorder module — using it here keeps the persisted
  // `steps[]` array and the generated `playwrightCode` in lock-step (any
  // drift breaks side-by-side rendering on the Test Detail page and
  // step-based edit/regeneration that indexes by position).
  const emittableActions = filterEmittableActions(dedupedActions);

  // Dedupe the requested name against existing tests in the same project so
  // two recordings saved with the same name (or two no-name saves whose
  // default ISO-timestamp default collides at the same millisecond) don't
  // produce two indistinguishable rows in the Tests list. If a collision
  // resolves, the generated `playwrightCode` still carries the *original*
  // name — regenerate the body with the deduped name so the code's `test(...)`
  // label and the persisted `name` column stay in sync (test runners surface
  // the embedded label in failure reports).
  const uniqueName = dedupeTestName(project.id, name);
  const playwrightCode = uniqueName !== name
    ? actionsToPlaywrightCode(uniqueName, stopResult.url, emittableActions)
    : stopResult.playwrightCode;

  const testId = generateTestId();
  const test = {
    id: testId,
    projectId: project.id,
    name: uniqueName,
    description: `Recorded from ${stopResult.url}`,
    // Match the human-readable step convention used by the AI generate/crawl
    // pipeline (`outputSchema.js`) and the manual-test creation path: short
    // English sentences a manual tester can follow ("User clicks the Sign Up
    // button"), NOT raw CDP-event strings like "Step 1: click → #login". The
    // Test Detail page renders all three sources through the same Steps panel,
    // so visual alignment matters — recorder tests previously stuck out as the
    // only ones showing engineer-shaped output.
    steps: emittableActions.map((a) => recordedActionToStepText(a)),
    playwrightCode,
    priority: "medium",
    type: "recorded",
    sourceUrl: stopResult.url,
    pageTitle: project.name,
    createdAt: new Date().toISOString(),
    lastResult: null,
    lastRunAt: null,
    qualityScore: null,
    isJourneyTest: false,
    reviewStatus: "draft",
    reviewedAt: null,
    promptVersion: null,
    modelUsed: null,
    linkedIssueKey: null,
    tags: ["recorded"],
    generatedFrom: "recorder",
    workspaceId: project.workspaceId || null,
  };
  testRepo.create(test);

  logActivity({ ...actor(req),
    type: "test.record_stop", projectId: project.id, projectName: project.name,
    testId, testName: uniqueName,
    detail: `Recorder captured ${stopResult.actions.length} actions → Draft test${uniqueName !== name ? ` (renamed to "${uniqueName}" to avoid duplicate)` : ""}`, status: "success",
  });

  res.status(201).json({
    test,
    actionCount: stopResult.actions.length,
    ...(recoveredFromAutoTimeout ? { recoveredFromAutoTimeout: true } : {}),
  });
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/input
 *
 * Forwards a single input event (mouse click/move, keyboard, scroll) from
 * the browser-in-browser canvas in RecorderModal to the headless Playwright
 * page via CDP. This is what makes the recorder interactive — without this
 * route the canvas is a read-only screencast and the user can never produce
 * any recorded actions.
 *
 * Intentionally no rate-limiter here: input events arrive at ~60fps during
 * active use. The route is cheap (one async CDP send) and already gated
 * behind requireRole("qa_lead") + workspace scope.
 *
 * @route POST /api/v1/projects/:id/record/:sessionId/input
 * @auth requireRole("qa_lead")
 * @body {{ type: string, x?: number, y?: number, button?: number,
 *           clickCount?: number, key?: string, code?: string,
 *           text?: string, modifiers?: number,
 *           deltaX?: number, deltaY?: number }}
 * @returns {200} { ok: true }
 * @returns {400} { error: string } — missing/invalid event type
 * @returns {404} { error: string } — session not found
 */
router.post("/projects/:id/record/:sessionId/input", requireRole("qa_lead"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }

  const VALID_TYPES = new Set(["mousePressed", "mouseReleased", "mouseMoved", "keyDown", "keyUp", "char", "scroll", "shortcutCapture"]);
  const { type } = req.body || {};
  if (!type || !VALID_TYPES.has(type)) {
    return res.status(400).json({ error: `Invalid event type. Must be one of: ${[...VALID_TYPES].join(", ")}` });
  }

  try {
    await forwardInput(req.params.sessionId, req.body);
    res.json({ ok: true });
  } catch (err) {
    // Session gone mid-flight (auto-timeout race) — treat as 404 not 500
    if (/not found/i.test(err.message || "")) {
      return res.status(404).json({ error: "recording session not found" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/assertion
 * Add a manual assertion step while recording.
 */
router.post("/projects/:id/record/:sessionId/assertion", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }
  try {
    const action = addAssertionAction(req.params.sessionId, req.body || {});
    res.status(201).json({ ok: true, action });
  } catch (err) {
    if (/Invalid assertion/i.test(err.message || "")) {
      return res.status(400).json({ error: err.message });
    }
    if (/not found|not recording/i.test(err.message || "")) {
      return res.status(404).json({ error: "recording session not found" });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/pause
 * Pause action capture for an in-flight recording. The headless browser
 * stays open and the screencast keeps streaming, but `forwardInput` and
 * the `__sentriRecord` binding short-circuit while `session.paused` is
 * true so user clicks/keystrokes during the pause window are not
 * persisted as recorded actions.
 */
router.post("/projects/:id/record/:sessionId/pause", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }
  try {
    const result = pauseRecording(req.params.sessionId);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/not found|not recording/i.test(err.message || "")) return res.status(404).json({ error: "recording session not found" });
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/resume
 * Resume action capture after a pause. Idempotent — calling resume on a
 * session that was never paused is a no-op.
 */
router.post("/projects/:id/record/:sessionId/resume", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }
  try {
    const result = resumeRecording(req.params.sessionId);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/not found|not recording/i.test(err.message || "")) return res.status(404).json({ error: "recording session not found" });
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/probe
 * DIF-015c Gap 2 (point-and-click assert UX) — read-only probe that
 * returns the `{selector, label, rect}` for an arbitrary viewport
 * coordinate. The frontend uses this to highlight the hovered element
 * inside `LiveBrowserView` and pre-fill the "Add verification" form on
 * click, matching how Playwright codegen's inspector behaves. NOT a
 * mutation — does not record an action; safe to call at hover frequency.
 *
 * Returns `{ probe: null }` when no interactive ancestor is found under
 * the cursor (page background, missing recorder script) so the frontend
 * can drop the highlight rather than show a stale overlay.
 */
router.post("/projects/:id/record/:sessionId/probe", requireRole("qa_lead"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }
  const { x, y } = req.body || {};
  // Reject `null` / `undefined` / missing-key payloads explicitly — `Number(null)`
  // coerces to 0 (finite), which would otherwise let `{ "x": null, "y": null }`
  // slip past as a probe at viewport (0, 0). `probeAtPoint` clamps gracefully
  // downstream, but the operator would see whatever happens to be at the
  // top-left corner returned as the "hovered" element, which is confusing.
  if (x == null || y == null || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    return res.status(400).json({ error: "x and y must be finite numbers" });
  }
  try {
    const probe = await probeAtPoint(req.params.sessionId, { x, y });
    res.json({ probe });
  } catch (err) {
    if (/not found|not recording|no active page/i.test(err.message || "")) {
      return res.status(404).json({ error: "recording session not found" });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/device
 * DIF-015c Gap 5 — switch the active device profile mid-recording. The
 * server tears down the current page + Playwright context, rebuilds them
 * under the new descriptor against the same browser process, and
 * restarts the CDP screencast at the new viewport. Captured
 * `session.actions[]` survive the switch; page state (cookies, form
 * values) does not. The frontend gates the call behind a confirmation
 * modal so operators understand the trade-off.
 */
router.post("/projects/:id/record/:sessionId/device", requireRole("qa_lead"), async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }
  const rawDevice = req.body?.device;
  const device = rawDevice == null ? "" : String(rawDevice);
  if (device && !RECORDER_DEVICE_VALUES.has(device)) {
    return res.status(400).json({ error: `Invalid device: ${device}` });
  }
  try {
    const result = await switchDevice(req.params.sessionId, device);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/not found|not recording/i.test(err.message || "")) return res.status(404).json({ error: "recording session not found" });
    if (/Invalid device/i.test(err.message || "")) return res.status(400).json({ error: err.message });
    if (/Device switch failed/i.test(err.message || "")) {
      console.error(formatLogLine("error", null, `[POST record/${req.params.sessionId}/device] ${err.message}`));
      return res.status(500).json({ error: "Device switch failed — recorder torn down. Re-launch the recorder to continue." });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/v1/projects/:id/record/:sessionId/pop-last
 * Undo the most recent captured action. Idempotent on an empty
 * `session.actions[]` — returns `{ removed: null, actionCount: 0 }`
 * rather than 4xx so the UI can fire the button without first checking
 * step count.
 */
router.post("/projects/:id/record/:sessionId/pop-last", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }
  try {
    const result = popLastRecordingAction(req.params.sessionId);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/not found|not recording/i.test(err.message || "")) return res.status(404).json({ error: "recording session not found" });
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/v1/projects/:id/record/:sessionId
 * Inspect an in-flight recording (action count, status). Used by the modal
 * to poll for captured actions while the browser is still open.
 */
router.get("/projects/:id/record/:sessionId", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  const sess = getRecording(req.params.sessionId);
  if (!sess || sess.projectId !== project.id) {
    return res.status(404).json({ error: "recording session not found" });
  }
  res.json({
    sessionId: sess.id,
    status: sess.status,
    url: sess.url,
    startedAt: sess.startedAt,
    actionCount: sess.actions.length,
    actions: sess.actions.map(a => ({ kind: a.kind, selector: a.selector, label: a.label, value: a.value, key: a.key, url: a.url, ts: a.ts })),
  });
});

export default router;
