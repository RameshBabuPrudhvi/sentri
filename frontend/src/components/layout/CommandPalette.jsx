/**
 * CommandPalette.jsx — Two-mode command palette for Sentri
 *
 * Mode 1: COMMAND MODE (default)
 *   Fuzzy-search over navigation, actions, and entities.
 *   Zero LLM cost — pure frontend string matching.
 *
 * Mode 2: AI CHAT MODE (fallback)
 *   Type a natural-language question, falls through to AIChat.
 *
 * Prefix rules:
 *   ">" = force command mode
 *   "?" = force AI chat mode
 *   No prefix = unified search (commands first, AI fallback)
 *
 * Styling: CSS classes from `styles/features/command-palette.css` only.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search, X, LayoutDashboard, FolderOpen, FlaskConical, BarChart2,
  Briefcase, Layers, Settings, Sparkles, Plus, Play, ArrowRight,
  Command, ChevronRight, Hash,
} from "lucide-react";
import fuzzyMatch from "../../utils/fuzzyMatch.js";

// ── Highlight matched ranges ──────────────────────────────────────────────────
function HighlightedText({ text, ranges }) {
  if (!ranges || ranges.length === 0) return <span>{text}</span>;
  const parts = [];
  let last = 0;
  for (const [start, end] of ranges) {
    if (start > last) parts.push(<span key={`p${last}`}>{text.slice(last, start)}</span>);
    parts.push(<mark key={`m${start}`} className="cmdp-highlight">{text.slice(start, end + 1)}</mark>);
    last = end + 1;
  }
  if (last < text.length) parts.push(<span key={`p${last}`}>{text.slice(last)}</span>);
  return <>{parts}</>;
}

// ── Command registry ──────────────────────────────────────────────────────────
function useCommands() {
  const navigate = useNavigate();
  return useMemo(() => [
    { id: "nav-dashboard",   group: "Navigation", label: "Go to Dashboard",  icon: LayoutDashboard, keywords: "home overview stats",      action: () => navigate("/dashboard") },
    { id: "nav-projects",    group: "Navigation", label: "Go to Projects",   icon: FolderOpen,      keywords: "applications apps",        action: () => navigate("/projects") },
    { id: "nav-tests",       group: "Navigation", label: "Go to Tests",      icon: FlaskConical,    keywords: "test cases suite",         action: () => navigate("/tests") },
    { id: "nav-reports",     group: "Navigation", label: "Go to Reports",    icon: BarChart2,       keywords: "analytics charts",         action: () => navigate("/reports") },
    { id: "nav-runs",        group: "Navigation", label: "Go to Runs",       icon: Briefcase,       keywords: "executions history",       action: () => navigate("/runs") },
    { id: "nav-system",      group: "Navigation", label: "Go to System",     icon: Layers,          keywords: "system info",              action: () => navigate("/system") },
    { id: "nav-settings",    group: "Navigation", label: "Go to Settings",   icon: Settings,        keywords: "config api keys provider", action: () => navigate("/settings") },
    { id: "act-new-project", group: "Actions",    label: "Create New Project", icon: Plus, keywords: "add application",    action: () => navigate("/projects/new") },
    { id: "act-new-test",    group: "Actions",    label: "Generate Test",      icon: Play, keywords: "create ai generate", action: () => navigate("/tests") },
  ], [navigate]);
}

// ── CommandPalette ────────────────────────────────────────────────────────────
export default function CommandPalette({ isOpen, onClose, onOpenAIChat }) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const commands = useCommands();

  const forceCommand = query.startsWith(">");
  const forceAI = query.startsWith("?");
  const cleanQuery = (forceCommand || forceAI) ? query.slice(1).trimStart() : query;

  const results = useMemo(() => {
    if (forceAI) return [];
    return commands
      .map(cmd => {
        const lm = fuzzyMatch(cleanQuery, cmd.label);
        const km = fuzzyMatch(cleanQuery, cmd.keywords);
        const best = lm.score <= km.score ? lm : km;
        return { ...cmd, ...best, labelRanges: lm.match ? lm.ranges : [] };
      })
      .filter(c => c.match)
      .sort((a, b) => a.score - b.score);
  }, [commands, cleanQuery, forceAI]);

  const showAIFallback = !forceCommand && cleanQuery.length > 0;
  const aiRowIdx = results.length;
  const totalItems = results.length + (showAIFallback ? 1 : 0);
  const effectiveTotal = forceAI && cleanQuery ? 1 : totalItems;

  useEffect(() => { setSelectedIdx(0); }, [query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape" && isOpen) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${selectedIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const executeItem = useCallback((idx) => {
    if (forceAI) { onClose(); onOpenAIChat(cleanQuery); return; }
    if (idx === aiRowIdx && showAIFallback) { onClose(); onOpenAIChat(cleanQuery); }
    else if (idx < results.length) { onClose(); results[idx].action(); }
  }, [results, aiRowIdx, showAIFallback, cleanQuery, onClose, onOpenAIChat, forceAI]);

  function handleKeyDown(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, effectiveTotal - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (effectiveTotal > 0) executeItem(selectedIdx); }
  }

  if (!isOpen) return null;

  const grouped = {};
  results.forEach((r, idx) => {
    if (!grouped[r.group]) grouped[r.group] = [];
    grouped[r.group].push({ ...r, flatIdx: idx });
  });

  const mode = forceAI ? "ai" : forceCommand ? "command" : "unified";

  return (
    <>
      <div className="cmdp-backdrop" onClick={onClose} />
      <div className="cmdp-panel">
        {/* Input */}
        <div className="cmdp-input-area">
          <div className="cmdp-input-row">
            {mode === "ai"
              ? <Sparkles size={15} className="cmdp-input-icon cmdp-input-icon--ai" />
              : <Search size={15} className="cmdp-input-icon" />}
            <input
              ref={inputRef}
              className="cmdp-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode === "ai" ? "Ask Sentri AI anything\u2026"
                  : mode === "command" ? "Search commands\u2026"
                    : "Search commands or ask AI\u2026"
              }
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button className="cmdp-clear-btn" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
                <X size={13} />
              </button>
            )}
          </div>
          <div className="cmdp-mode-hints">
            <span className={`cmdp-mode-pill${mode === "command" ? " cmdp-mode-pill--active" : ""}`}>
              <Command size={9} /> Commands
            </span>
            <span className={`cmdp-mode-pill${mode === "ai" ? " cmdp-mode-pill--active" : ""}`}>
              <Sparkles size={9} /> AI Chat
            </span>
            <span className="cmdp-mode-hint-text">
              Type <kbd>&gt;</kbd> commands &middot; <kbd>?</kbd> AI
            </span>
          </div>
        </div>

        {/* Results */}
        <div className="cmdp-results" ref={listRef}>
          {mode === "ai" ? (
            <div className="cmdp-group">
              <div
                className={`cmdp-item cmdp-item--ai${selectedIdx === 0 ? " cmdp-item--selected" : ""}`}
                data-idx={0}
                onClick={() => executeItem(0)}
                onMouseEnter={() => setSelectedIdx(0)}
              >
                <div className="cmdp-item__icon cmdp-item__icon--ai"><Sparkles size={14} /></div>
                <div className="cmdp-item__body">
                  <div className="cmdp-item__label">Ask Sentri AI</div>
                  <div className="cmdp-item__desc">{cleanQuery || "Type your question\u2026"}</div>
                </div>
                <ArrowRight size={13} className="cmdp-item__arrow" />
              </div>
            </div>
          ) : (
            <>
              {Object.entries(grouped).map(([group, items]) => (
                <div className="cmdp-group" key={group}>
                  <div className="cmdp-group__label">{group}</div>
                  {items.map(item => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.id}
                        className={`cmdp-item${item.flatIdx === selectedIdx ? " cmdp-item--selected" : ""}`}
                        data-idx={item.flatIdx}
                        onClick={() => executeItem(item.flatIdx)}
                        onMouseEnter={() => setSelectedIdx(item.flatIdx)}
                      >
                        <div className="cmdp-item__icon"><Icon size={14} /></div>
                        <div className="cmdp-item__body">
                          <div className="cmdp-item__label">
                            <HighlightedText text={item.label} ranges={item.labelRanges} />
                          </div>
                        </div>
                        <ChevronRight size={13} className="cmdp-item__arrow" />
                      </div>
                    );
                  })}
                </div>
              ))}

              {showAIFallback && (
                <div className="cmdp-group">
                  <div className="cmdp-group__label">AI Assistant</div>
                  <div
                    className={`cmdp-item cmdp-item--ai${aiRowIdx === selectedIdx ? " cmdp-item--selected" : ""}`}
                    data-idx={aiRowIdx}
                    onClick={() => executeItem(aiRowIdx)}
                    onMouseEnter={() => setSelectedIdx(aiRowIdx)}
                  >
                    <div className="cmdp-item__icon cmdp-item__icon--ai"><Sparkles size={14} /></div>
                    <div className="cmdp-item__body">
                      <div className="cmdp-item__label">Ask Sentri AI</div>
                      <div className="cmdp-item__desc">&ldquo;{cleanQuery}&rdquo;</div>
                    </div>
                    <ArrowRight size={13} className="cmdp-item__arrow" />
                  </div>
                </div>
              )}

              {results.length === 0 && !showAIFallback && !cleanQuery && (
                <div className="cmdp-empty">
                  <Hash size={18} style={{ opacity: 0.3, marginBottom: 6 }} />
                  <div>Type to search commands</div>
                  <div className="cmdp-empty__sub">or prefix with <kbd>?</kbd> to ask AI</div>
                </div>
              )}

              {results.length === 0 && forceCommand && cleanQuery && (
                <div className="cmdp-empty">
                  <div>No matching commands</div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="cmdp-footer">
          <span className="cmdp-footer__hint"><kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate</span>
          <span className="cmdp-footer__hint"><kbd>&crarr;</kbd> select</span>
          <span className="cmdp-footer__hint"><kbd>esc</kbd> close</span>
        </div>
      </div>
    </>
  );
}
