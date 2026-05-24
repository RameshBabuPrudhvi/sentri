/**
 * @module components/test-lab/TestLabConfigPanel
 * @description Middle-column configuration body for Test Lab — the
 * `tl-config` view that renders when no run is attached.
 *
 * Owns the entire idle-state middle column: error banner + (on the
 * Requirement tab) the `<RequirementComposer>` sub-block + the unified
 * `<TestConfig>` dials surface. The right-rail launch panel
 * (`tl-panel`) is a sibling and stays in `pages/TestLab.jsx` for now —
 * that extraction is Piece 3.
 *
 * AGENT.md §40 — helpers with their own JSX surface belong in a sibling
 * file once they exceed a screenful. The previous PR extracted only
 * `<RequirementComposer>` (~104 lines); this file now also owns the
 * `tl-config-scroll` wrapper + error banner + `<TestConfig>` so the
 * parent's render path drops from ~140 lines to a single component
 * call.
 *
 * ### Prop contract (current surface — Requirement composer only)
 *
 *   testName, setTestName              — controlled input for the
 *                                        optional name override
 *   requirement, setRequirement        — controlled textarea for the
 *                                        user story / requirement text
 *   requirementRef                     — `useRef` from the page for the
 *                                        autofocus-on-tab-switch effect
 *   attachments                        — `[{ name, content }]` array
 *   onRemoveAttachment                 — `removeAttachment(fileName)`
 *   showImportIssue, setShowImportIssue — toggles the Jira-paste dialog
 *   importIssueText, setImportIssueText — controlled value for the dialog
 *   onImportIssue                      — `handleImportIssue()`
 *   onFileSelect                       — `handleFileSelect(event)`
 *   fileInputRef                       — `useRef` from the page (the
 *                                        toolbar's paperclip triggers
 *                                        `fileInputRef.current?.click()`)
 *   acceptedExtensions                 — comma-separated extension list
 *                                        for the hidden `<input type="file">`
 *                                        accept attribute (mirrors the
 *                                        page-level `ACCEPTED_EXTENSIONS`
 *                                        constant so the allowlist stays
 *                                        a single source of truth)
 *   launching                          — disables the Cmd/Ctrl+Enter
 *                                        submit shortcut while a launch
 *                                        is in flight
 *   selectedProject                    — required for the Cmd/Ctrl+Enter
 *                                        gate (same `selectedProject &&`
 *                                        check the inline version had)
 *   onSubmit                           — `handleGenerateFromRequirement`
 *                                        from the page, fired on
 *                                        Cmd/Ctrl+Enter
 *
 * The component is intentionally a pass-through — every value is owned
 * by the parent. This keeps the migration mechanical (no state moves)
 * so the visual + behavioural surface is byte-identical to the inline
 * version it replaces.
 */

import React from "react";
import { Paperclip, Trash2, Upload } from "lucide-react";
import TestConfig from "../test/TestConfig.jsx";

/**
 * Requirement composer surface — the testName + Import Issue + textarea
 * + attachment chips + toolbar block formerly inline in `TestLab.jsx`
 * around lines 1803-1906.
 *
 * Currently the only export from this file; future PRs add the full
 * config-panel JSX (dialsConfig, environments dropdown, launch stats,
 * Start/Generate buttons, panel-side Retry).
 */
export function RequirementComposer({
  testName,
  setTestName,
  requirement,
  setRequirement,
  requirementRef,
  attachments,
  onRemoveAttachment,
  showImportIssue,
  setShowImportIssue,
  importIssueText,
  setImportIssueText,
  onImportIssue,
  onFileSelect,
  fileInputRef,
  acceptedExtensions,
  launching,
  selectedProject,
  onSubmit,
}) {
  return (
    <>
      {/* Test Name override — optional. Blank = auto-derive from the
          first line of the requirement at submit. */}
      <div className="tl-section">
        <div className="tl-section-label">
          Test Name
          <span className="tl-section-label-hint">
            (optional — auto-derived from the requirement if blank)
          </span>
        </div>
        <input
          className="tl-select tl-name-input"
          type="text"
          value={testName}
          onChange={e => setTestName(e.target.value)}
          placeholder="e.g. Dashboard loads all employee charts"
        />
      </div>

      {/* Requirement composer — single inline surface that bundles
          attachment chips, the textarea, and an action toolbar
          (📎 attach, Import Issue) below the input. Mirrors the
          chat-style composer pattern from ChatGPT / Claude / Cursor:
          file uploads aren't a separate section, they're an inline
          affordance on the message you're writing. */}
      <div className="tl-section">
        <div className="tl-section-label">Requirement / User Story</div>

        {showImportIssue && (
          <div className="tl-import-issue">
            <div className="tl-import-issue-label">
              Paste a Jira issue (title on first line, description below)
            </div>
            <textarea
              className="tl-req-area tl-import-issue-textarea"
              value={importIssueText}
              onChange={e => setImportIssueText(e.target.value)}
              placeholder={"PROJ-123 Login fails for SSO users\nAs a user with SSO enabled I expect to be redirected to the IdP…"}
              rows={4}
              autoFocus
            />
            <div className="tl-import-issue-actions">
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => { setShowImportIssue(false); setImportIssueText(""); }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary btn-xs"
                onClick={onImportIssue}
                disabled={!importIssueText.trim()}
              >
                Import
              </button>
            </div>
          </div>
        )}

        <div className="tl-composer">
          {/* Attachment chips — render inline above the textarea
              (like Claude / ChatGPT) so users see what's attached as
              part of the message they're sending. */}
          {attachments.length > 0 && (
            <div className="tl-composer-chips">
              {attachments.map(a => (
                <span key={a.name} className="tl-attachment-chip" title={`${Math.round(a.content.length / 1000)}k chars`}>
                  <Paperclip size={11} />
                  <span className="tl-attachment-chip-name">{a.name}</span>
                  <button
                    type="button"
                    className="tl-attachment-chip-remove"
                    onClick={() => onRemoveAttachment(a.name)}
                    title="Remove attachment"
                    aria-label={`Remove ${a.name}`}
                  >
                    <Trash2 size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={requirementRef}
            className="tl-req-area tl-composer-area"
            placeholder={"As a user I want to search for items so that I can find what I'm looking for…"}
            value={requirement}
            onChange={e => setRequirement(e.target.value)}
            // Cmd/Ctrl+Enter submits — matches GenerateTestModal's
            // single-key submit, but scoped to a modifier so plain
            // Enter still inserts a newline in this multi-line area.
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (requirement.trim() && selectedProject && !launching) {
                  onSubmit();
                }
              }
            }}
            rows={5}
          />

          {/* Action toolbar — paperclip + Import Issue render
              inside the composer footer, ChatGPT-style, so
              attachments aren't a parallel section the user has
              to scroll past. */}
          <div className="tl-composer-toolbar">
            <button
              type="button"
              className="tl-composer-action"
              onClick={() => fileInputRef.current?.click()}
              title="Attach a text file (.md, .json, .yaml, .feature, …)"
            >
              <Paperclip size={13} />
              <span>Attach</span>
            </button>
            <button
              type="button"
              className="tl-composer-action"
              onClick={() => setShowImportIssue(v => !v)}
              title="Paste a Jira / GitHub issue and auto-split into name + description"
            >
              <Upload size={13} />
              <span>Import issue</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={acceptedExtensions}
              multiple
              onChange={onFileSelect}
              className="tl-file-input-hidden"
            />
            <span className="tl-composer-hint">
              <kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> to generate
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Test Lab middle-column config body — the `tl-config` surface shown
 * when no run is attached. Bundles the error banner, the
 * `<RequirementComposer>` (Requirement tab only), and the unified
 * `<TestConfig>` dials.
 *
 * Pure pass-through: every value + handler is owned by `pages/TestLab.jsx`,
 * so the visual + behavioural surface is byte-identical to the inline
 * version it replaces.
 *
 * @param {Object} props
 * @param {"crawl"|"requirement"} props.tab          - active page tab.
 * @param {string|null}           props.error        - launch-time error message.
 * @param {Object}                props.dialsConfig  - canonical Test Dials shape.
 * @param {Function}              props.setDialsConfig
 * @param {Object}                props.composerProps - props forwarded verbatim
 *   to `<RequirementComposer>` (see that component's prop contract above).
 *   Only consumed when `tab === "requirement"`.
 */
export default function TestLabConfigPanel({
  tab,
  error,
  dialsConfig,
  setDialsConfig,
  composerProps,
}) {
  return (
    <div className="tl-config">
      <div className="tl-config-scroll">

        {/* Error banner — launch-time errors only; run-terminal
            banners live inside the run-center view in the parent. */}
        {error && (
          <div className="banner banner-error mb-md">
            {error}
          </div>
        )}

        {/* Requirement input + extras — Requirement tab only. */}
        {tab === "requirement" && (
          <RequirementComposer {...composerProps} />
        )}

        {/* ── Unified Test Dials surface ──
            Crawl tab gets the Explorer sub-tab (discovery mode + state-
            explorer tuning); Requirement tab hides it because the
            requirement flow doesn't crawl. The component is fully
            controlled — `dialsConfig` is the single source of truth and
            feeds the API call sites directly. */}
        <TestConfig
          value={dialsConfig}
          onChange={setDialsConfig}
          showExplorer={tab === "crawl"}
          // Crawl tab: pick-a-URL vs. explore-state is the most
          // consequential choice on this flow, so we lift it out of
          // the sub-tab strip and render it as a prominent header.
          // Requirement tab keeps the sub-tab layout (no crawl ⇒ no
          // discovery decision to make).
          showDiscoveryHeader={tab === "crawl"}
          // `parallelWorkers` is consumed only by the test runner
          // (POST /projects/:id/run → testRunner.js). Both Test Lab
          // flows are pre-runner (crawl + AI generation), so the
          // backend silently ignores the field — hiding it avoids
          // surfacing a no-op control to users.
          showRunnerOptions={false}
        />
      </div>
    </div>
  );
}
