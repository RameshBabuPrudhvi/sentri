/**
 * @module components/test-lab/TestLabLaunchPanel
 * @description Test Lab right-rail panel — the `tl-panel` surface that
 * sits to the right of the middle config / run-center column.
 *
 * Two modes (mutually exclusive, driven by `activeRun`):
 *
 *   • **Attached-run mode** (`activeRun != null`) — shows a context
 *     card for the running/done/failed run, final-test stats when
 *     terminal, and the action stack (Stop / Review drafts / View
 *     auto-approved / Retry / View run detail / New run).
 *
 *   • **Idle mode** (`activeRun == null`) — shows the Launch panel:
 *     pre-launch stats (`pagesFound` / `existingTests` / requirement
 *     readiness), Requirement-tab examples, optional environment
 *     dropdown, the Start Crawl / Generate CTA, and an "Active runs"
 *     list of cross-project running runs (max 3) so the operator can
 *     re-attach with one click.
 *
 * Pure pass-through — every value + handler is owned by
 * `pages/TestLab.jsx`. The visual + behavioural surface is byte-
 * identical to the inline version it replaces.
 *
 * AGENTS.md §40 — extraction triggers once a JSX surface exceeds a
 * screenful (~270 lines for this panel) AND has its own reusable
 * shape. The middle-column body lives in `<TestLabConfigPanel>`; this
 * is the natural sibling.
 *
 * ### Prop contract
 *
 *   Run state:
 *     activeRun, runData, isRunActive, isRunDone, isRunFailed,
 *     ps (pipelineStats), generatedOutcome, stopLoading, launching
 *
 *   Tab + selection:
 *     tab, selectedProject, projects
 *
 *   Idle-mode data:
 *     pagesFound, existingTests, requirement, environments,
 *     environmentId, setEnvironmentId, activeQueueRuns,
 *     reqExamples, pipelineStages, setRequirement
 *
 *   Dependency injection:
 *     ProjIcon (component) — page-local avatar component closes over
 *       `avatarStyle`, so we accept it as a prop instead of duplicating
 *       the hue map here.
 *
 *   Handlers:
 *     onStop, onRetry, onReset, onStartCrawl, onGenerate, onAttachRun,
 *     onNavigateReviewQueue (projectId), onNavigateProjectTests (projectId),
 *     onNavigateRunDetail (runId)
 */

import React from "react";
import {
  StopCircle, ChevronRight, RotateCcw, Play, Zap,
} from "lucide-react";

export default function TestLabLaunchPanel({
  // Run state
  activeRun,
  runData,
  isRunActive,
  isRunDone,
  isRunFailed,
  ps,
  generatedOutcome,
  stopLoading,
  launching,
  // Tab + selection
  tab,
  selectedProject,
  projects,
  // Idle-mode data
  pagesFound,
  existingTests,
  requirement,
  environments,
  environmentId,
  setEnvironmentId,
  activeQueueRuns,
  reqExamples,
  pipelineStages,
  setRequirement,
  // DI
  ProjIcon,
  // Handlers
  onStop,
  onRetry,
  onReset,
  onStartCrawl,
  onGenerate,
  onAttachRun,
  onNavigateReviewQueue,
  onNavigateProjectTests,
  onNavigateRunDetail,
}) {
  return (
    <div className="tl-panel">
      <div className="tl-panel-scroll">

        {activeRun ? (
          // ── Attached run: stats now live inline in the pipeline view.
          // Right panel shows a minimal context card + quick navigation.
          <>
            <div className="tl-panel-section-label">
              {isRunActive ? "Running" : isRunDone ? "Completed" : "Stopped"}
            </div>
            <div className="tl-stat-cell tl-stat-cell--header">
              <div className="tl-stat-cell__title">
                {selectedProject?.name ?? "—"}
              </div>
              <div className="tl-stat-cell__sub">
                {activeRun?.type === "crawl" ? "Crawl & Generate" : "From Requirement"}
              </div>
            </div>

            {/* Final test count — shown when done */}
            {(isRunDone || isRunFailed) && (
              <div className="tl-run-stats tl-run-stats--final">
                <div className="tl-run-stat tl-run-stat--accent">
                  <div className="tl-run-stat-val">{runData?.testsGenerated ?? 0}</div>
                  <div className="tl-run-stat-lbl">Tests generated</div>
                </div>
                <div className="tl-run-stat tl-run-stat--green">
                  <div className="tl-run-stat-val">
                    {ps.averageQuality != null ? ps.averageQuality : "—"}
                  </div>
                  <div className="tl-run-stat-lbl">Avg quality</div>
                </div>
              </div>
            )}

            <hr className="tl-panel-divider" />

            {isRunActive ? (
              <button
                className="btn btn-ghost tl-full-btn"
                onClick={onStop}
                disabled={stopLoading}
              >
                <StopCircle size={15} />
                {stopLoading ? "Stopping…" : "Stop run"}
              </button>
            ) : (
              <div className="tl-btn-stack">
                {isRunDone && generatedOutcome.drafts > 0 && (
                  <button
                    className="btn btn-primary tl-full-btn"
                    onClick={() => onNavigateReviewQueue(activeRun.projectId)}
                  >
                    Review {generatedOutcome.drafts} draft{generatedOutcome.drafts !== 1 ? "s" : ""} <ChevronRight size={13} />
                  </button>
                )}
                {isRunDone && generatedOutcome.drafts === 0 && generatedOutcome.autoApproved > 0 && (
                  <button
                    className="btn btn-primary tl-full-btn"
                    onClick={() => onNavigateProjectTests(activeRun.projectId)}
                  >
                    View {generatedOutcome.autoApproved} auto-approved <ChevronRight size={13} />
                  </button>
                )}
                {/* G11 — Retry shows on failed/aborted runs (not on
                    completed runs — there's nothing to retry when the
                    pipeline succeeded). Same handler the banner uses;
                    the panel button is a redundant entry point for
                    users who've scrolled past the top-of-page banner. */}
                {isRunFailed && (
                  <button
                    className="btn btn-primary tl-full-btn"
                    onClick={onRetry}
                    disabled={launching}
                    title="Re-run with the same configuration"
                  >
                    {launching ? (
                      <><span className="spin"><RotateCcw size={13} /></span> Retrying…</>
                    ) : (
                      <><RotateCcw size={13} /> Retry run</>
                    )}
                  </button>
                )}
                <button
                  className="btn btn-ghost tl-full-btn"
                  onClick={() => onNavigateRunDetail(activeRun.runId)}
                >
                  View run detail <ChevronRight size={13} />
                </button>
                <button
                  className="btn btn-ghost tl-full-btn"
                  onClick={onReset}
                >
                  New run
                </button>
              </div>
            )}
          </>
        ) : (
          // ── Idle: launch panel + cross-project active runs ──
          <>
            {tab === "crawl" && (
              <>
                <div className="tl-panel-section-label">Ready to Launch</div>
                <div className="tl-launch-stats">
                  <div className="tl-stat-cell">
                    <div className="tl-stat-val">
                      {pagesFound != null ? pagesFound : <span className="tl-stat-placeholder">—</span>}
                    </div>
                    <div className="tl-stat-lbl">Pages found</div>
                  </div>
                  <div className="tl-stat-cell">
                    <div className="tl-stat-val">
                      {existingTests != null ? existingTests : <span className="tl-stat-placeholder">—</span>}
                    </div>
                    <div className="tl-stat-lbl">Existing tests</div>
                  </div>
                </div>

                {pagesFound != null && (
                  <div className="tl-estimate">
                    Estimated: <strong>8–15 new tests</strong> · ~4 min
                  </div>
                )}
              </>
            )}

            {tab === "requirement" && (
              <>
                <div className="tl-panel-section-label">Ready to Launch</div>
                <div className="tl-launch-stats">
                  <div className="tl-stat-cell">
                    <div className="tl-stat-val">
                      {existingTests != null ? existingTests : <span className="tl-stat-placeholder">—</span>}
                    </div>
                    <div className="tl-stat-lbl">Existing tests</div>
                  </div>
                  <div className="tl-stat-cell">
                    <div className="tl-stat-val tl-stat-val--text">
                      {requirement.trim() ? "Ready" : <span className="tl-stat-placeholder">—</span>}
                    </div>
                    <div className="tl-stat-lbl">Requirement</div>
                  </div>
                </div>
                {requirement.trim() && (
                  <div className="tl-estimate">
                    Focused generation: <strong>1–5 new tests</strong> · ~1–2 min
                  </div>
                )}
                <hr className="tl-panel-divider" />
                <div className="tl-panel-section-label">Examples</div>
                {reqExamples.map(ex => (
                  <button
                    key={ex}
                    className="tl-example"
                    onClick={() => setRequirement(ex)}
                  >
                    {ex}
                  </button>
                ))}
                <hr className="tl-panel-divider" />
              </>
            )}

            {/* DIF-012: environment selector — only renders when the
                selected project has ≥ 1 environment. Same shape as the
                RunRegressionModal dropdown so the run/crawl/generate
                UX stays uniform. Styles live in `pages/test-lab.css`
                under `.tl-env-*` to keep this JSX inline-style free. */}
            {environments.length > 0 && (
              <div className="tl-env-section">
                <div className="tl-panel-section-label">Environment</div>
                <select
                  className="tl-select tl-env-select"
                  value={environmentId}
                  onChange={(e) => setEnvironmentId(e.target.value)}
                >
                  <option value="">Default (project URL)</option>
                  {environments.map((env) => (
                    <option key={env.id} value={env.id}>{env.name} — {env.baseUrl}</option>
                  ))}
                </select>
              </div>
            )}

            {/* CTA */}
            {!selectedProject && (
              <div className="banner banner-warning mb-md">
                Select a project to continue.
              </div>
            )}

            {tab === "crawl" && (
              <button
                className="btn btn-primary tl-full-btn--padded"
                disabled={!selectedProject || launching}
                onClick={onStartCrawl}
              >
                {launching ? (
                  <><span className="spin"><RotateCcw size={15} /></span> Starting…</>
                ) : (
                  <><Play size={15} /> Start Crawl &amp; Generate</>
                )}
              </button>
            )}

            {tab === "requirement" && (
              <button
                className="btn btn-primary tl-full-btn--padded"
                disabled={!selectedProject || !requirement.trim() || launching}
                onClick={onGenerate}
              >
                {launching ? (
                  <><span className="spin"><RotateCcw size={15} /></span> Generating…</>
                ) : (
                  <><Zap size={15} /> Generate Tests</>
                )}
              </button>
            )}

            <hr className="tl-panel-divider" />
            <div className="tl-panel-section-label">Active Runs</div>

            {activeQueueRuns.length === 0 ? (
              <div className="tl-active-run-empty">No active runs</div>
            ) : (
              activeQueueRuns.slice(0, 3).map(run => {
                const proj = projects.find(p => p.id === run.projectId);
                const pct  = run.currentStep != null
                  ? Math.round(((run.currentStep - 1) / 7) * 100)
                  : 0;
                return (
                  <button
                    key={run.id}
                    type="button"
                    className="tl-active-run-card tl-active-run-card-btn mb-sm"
                    onClick={() => onAttachRun(run)}
                    title="View live pipeline for this run"
                  >
                    <div className="tl-arc-header">
                      <ProjIcon project={proj} />
                      <span className="tl-arc-name">{proj?.name ?? "—"}</span>
                      <span className="badge badge-blue tl-arc-live-badge">live</span>
                    </div>
                    <div className="tl-arc-body">
                      <div className="tl-arc-step">
                        Step {run.currentStep ?? "?"}/8 · {pipelineStages[(run.currentStep ?? 1) - 1]?.label}
                      </div>
                      <div className="progress-bar">
                        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </>
        )}
      </div>
    </div>
  );
}
