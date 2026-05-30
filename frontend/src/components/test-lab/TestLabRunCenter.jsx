/**
 * @module components/test-lab/TestLabRunCenter
 * @description Middle column rendered when a run is attached in Test Lab.
 *   Owns the run-label header, SSE reconnection banners, terminal Done/
 *   Failed banners, inner-tabs (Pipeline / Site graph / Logs), and the
 *   three sub-columns of the pipeline view (stage list, agent
 *   conversation, So Far stats + stop button).
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 * decomposition (audit §3.1). This was the heaviest remaining block in
 * the page file — a ~215-line IIFE wrapping the inner-tab routing plus
 * the run-center render tree. Pulling it into a dedicated component
 * removes the IIFE entirely and makes the page's top-level render read
 * like a state machine: `activeRun ? <RunCenter /> : <ConfigPanel />`.
 *
 * Props are intentionally page-owned reads — this component does not
 * mutate `runData` / `logLines` / `activeRun`. The only writer it owns
 * is `setInnerTab`, which is parent-owned state passed in. Keeping it
 * presentational means the G9 parallel-runs migration (which lives on
 * the page) can swap the data source from single-run state to the
 * `runDataByRunId` / `logLinesByRunId` Maps without touching this file.
 */
import React from "react";
import { StopCircle, RefreshCw } from "lucide-react";
import SiteGraph from "../crawl/SiteGraph.jsx";
import AgentConversation from "../ai/AgentConversation.jsx";
import PipelinePanel, { PIPELINE_STAGES } from "./PipelinePanel.jsx";
import LiveLog from "./LiveLog.jsx";
import { RunDoneBanner, RunFailedBanner } from "./RunBanners.jsx";

export default function TestLabRunCenter({
  activeRun,
  runData,
  runStatus,
  isRunActive,
  isRunDone,
  isRunFailed,
  ps,
  logLines,
  allTests,
  generatedOutcome,
  launching,
  stopLoading,
  innerTab,
  setInnerTab,
  projects,
  retryIn,
  sseDown,
  onStop,
  onRetry,
  onReset,
}) {
  // Site Graph is only meaningful for crawl runs — the requirement flow
  // doesn't produce a page graph. Same shape as CrawlView's `graphPages`
  // derivation (`run.pages` or `run.snapshots`, normalised to an array).
  const isCrawl = activeRun?.type === "crawl";
  const rawPages = runData?.pages ?? runData?.snapshots ?? [];
  const graphPages = Array.isArray(rawPages)
    ? rawPages
    : (typeof rawPages === "object" ? Object.values(rawPages) : []);

  // Derive the page currently being crawled from the latest log line —
  // mirrors CrawlView.jsx:48-54.
  let activePage = null;
  for (let i = logLines.length - 1; i >= 0; i--) {
    const m = logLines[i].match(/https?:\/\/[^\s)]+/);
    if (m) { activePage = m[0]; break; }
  }

  // "logs" tab kept for crawl runs only — the narrative feed is the
  // primary view; raw log is accessible via the Logs tab for debugging.
  // Requirement runs don't crawl so no sitegraph.
  const innerTabs = isCrawl
    ? ["pipeline", "sitegraph", "logs"]
    : ["pipeline", "logs"];
  const labelFor = (t) => t === "sitegraph" ? "Site graph"
    : t.charAt(0).toUpperCase() + t.slice(1);

  // G10 — the run-center label shows the RUN's project, not the sidebar's
  // `selectedProject`. After the project-switch decoupling, those can
  // diverge: user starts a crawl on MYPROJ-A, then clicks MYPROJ-B in
  // the sidebar to browse its tests. The middle column must still show
  // "MYPROJ-A · LINK CRAWL" because that's the run we're monitoring.
  // Resolved by id from the shared `projects` cache; falls back to the
  // bare project id when the cache hasn't populated yet (defence-in-depth).
  const runProjectName = projects.find(p => p.id === activeRun.projectId)?.name
    || activeRun.projectId
    || "—";

  return (
    <div className="tl-run-center">
      <div className="tl-run-label">
        {runProjectName.toUpperCase()} · {activeRun?.type === "crawl" ? "LINK CRAWL" : "REQUIREMENT"}
        {isRunDone && <span className="tl-run-status-suffix tl-run-status-suffix--done">· COMPLETED</span>}
        {isRunFailed && (
          <span className="tl-run-status-suffix tl-run-status-suffix--failed">
            · {runStatus === "aborted" ? "ABORTED" : "FAILED"}
          </span>
        )}
      </div>

      {/* SSE reconnection / polling-fallback banners — only shown while
          the run is actively running. Mirrors RunDetail.jsx so users get
          the same feedback wherever they monitor a run. */}
      {isRunActive && retryIn != null && !sseDown && (
        <div className="banner banner-info tl-banner-row">
          <RefreshCw size={13} className="tl-banner-row__icon" />
          <span>Connection lost — reconnecting in {retryIn}s…</span>
        </div>
      )}
      {isRunActive && sseDown && (
        <div className="banner banner-warning tl-banner-row">
          <RefreshCw size={13} className="spin tl-banner-row__icon" />
          <span>Live updates unavailable — refreshing every 5s.</span>
        </div>
      )}

      {/* Terminal banners — rendered at the top of the run view so the
          pipeline / logs stay visible underneath for review. */}
      {isRunDone && (
        <RunDoneBanner
          activeRun={activeRun}
          generatedOutcome={generatedOutcome}
          onReset={onReset}
        />
      )}

      {isRunFailed && (
        <RunFailedBanner
          activeRun={activeRun}
          runData={runData}
          runStatus={runStatus}
          launching={launching}
          onRetry={onRetry}
          onReset={onReset}
        />
      )}

      <div className="tl-inner-tabs">
        {innerTabs.map(t => (
          <button
            key={t}
            className={`tl-inner-tab${innerTab === t ? " tl-inner-tab--active" : ""}`}
            onClick={() => setInnerTab(t)}
          >
            {labelFor(t)}
          </button>
        ))}
      </div>

      {/* Pipeline tab: 3 sub-columns — Pipeline | Live Output | So Far */}
      {innerTab === "pipeline" && (
        <div className="tl-pipeline-view">
          {/* Sub-col 1: stage list */}
          <div className="tl-pipeline-col">
            <div className="tl-pipeline-progress-label">
              {runData?.currentStep != null && runData.status === "running"
                ? `Step ${runData.currentStep} of 8 · ${PIPELINE_STAGES[runData.currentStep - 1]?.label ?? ""}`
                : runData?.status === "completed" || runData?.status === "completed_empty"
                  ? "Completed"
                  : runData?.status === "failed" ? "Failed"
                  : runData?.status === "aborted" ? "Aborted"
                  : "Starting…"}
            </div>
            <div className="progress-bar tl-pipeline-progress-bar">
              <div
                className="progress-bar-fill"
                style={{
                  width: isRunDone ? "100%"
                    : runData?.currentStep != null
                      ? `${Math.round(((runData.currentStep - 1) / 7) * 100)}%`
                      : "0%",
                }}
              />
            </div>
            <PipelinePanel run={runData} />
          </div>

          {/* Sub-col 2: multi-agent chat transcript. */}
          <div className="tl-pipeline-log-col">
            <div className="tl-pipeline-col-label">What&rsquo;s happening</div>
            <AgentConversation
              run={runData}
              isRunActive={isRunActive}
              allTests={allTests}
            />
          </div>

          {/* Sub-col 3: so-far stats + stop button */}
          <div className="tl-pipeline-stats-col">
            <div className="tl-pipeline-col-label">So Far</div>
            <div className="tl-run-stats">
              <div className="tl-run-stat tl-run-stat--accent">
                <div className="tl-run-stat-val">{ps.rawTestsGenerated ?? runData?.testsGenerated ?? 0}</div>
                <div className="tl-run-stat-lbl">Generated</div>
              </div>
              <div className="tl-run-stat tl-run-stat--amber">
                <div className="tl-run-stat-val">{ps.duplicatesRemoved ?? 0}</div>
                <div className="tl-run-stat-lbl">Dupes removed</div>
              </div>
              <div className="tl-run-stat tl-run-stat--green">
                <div className="tl-run-stat-val">
                  {ps.averageQuality != null ? ps.averageQuality : "—"}
                </div>
                <div className="tl-run-stat-lbl">Avg quality</div>
              </div>
              <div className="tl-run-stat">
                <div className="tl-run-stat-val tl-pipeline-stat-val--default">
                  {ps.pagesFound ?? runData?.pagesFound ?? 0}
                </div>
                <div className="tl-run-stat-lbl">Pages crawled</div>
              </div>
            </div>

            {isRunActive ? (
              <button
                className="btn btn-ghost tl-pipeline-stat-btn"
                onClick={onStop}
                disabled={stopLoading}
              >
                <StopCircle size={15} />
                {stopLoading ? "Stopping…" : "Stop run"}
              </button>
            ) : !isRunDone && !isRunFailed ? null : (
              <button
                className="btn btn-ghost tl-pipeline-stat-btn"
                onClick={onReset}
              >
                New run
              </button>
            )}
          </div>
        </div>
      )}

      {innerTab === "sitegraph" && isCrawl && (
        <div className="tl-sitegraph-pane">
          <SiteGraph
            pages={graphPages}
            activePage={activePage}
            isRunning={isRunActive}
          />
        </div>
      )}

      {innerTab === "logs" && (
        <div className="tl-logs-pane">
          <LiveLog lines={logLines} />
        </div>
      )}
    </div>
  );
}
