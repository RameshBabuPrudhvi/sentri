/**
 * ChatHistory.jsx — Dedicated full-page AI chat with session history
 *
 * Replaces the modal chat for a proper chat-app experience:
 * - Sidebar with all past sessions (persisted in localStorage)
 * - Full chat view with the selected session
 * - Export to Markdown / JSON from the "…" menu
 * - New session, rename, delete
 *
 * Routing: /chat
 * CSS: styles/pages/chat-history.css
 */

import React, {
  useState, useRef, useEffect, useCallback, useMemo, memo,
} from "react";
import {
  Bot, User, Send, Square, Sparkles, Plus, Trash2, Download,
  MoreHorizontal, Check, Copy, MessageSquare, Search, X,
  Edit3, FileText, FileJson, ChevronRight,
} from "lucide-react";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { renderMarkdown } from "../utils/markdown.js";
import "../styles/pages/chat-history.css";

// ── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY_PREFIX = "sentri_chat_sessions";
const MAX_SESSIONS = 50;

// ── Persistence helpers ───────────────────────────────────────────────────────
function storageKey(userId) {
  return userId ? `${STORAGE_KEY_PREFIX}_${userId}` : STORAGE_KEY_PREFIX;
}

function loadSessions(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions, userId) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch { /* quota exceeded — fail silently */ }
}

function createSession(title = "New conversation") {
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
}

function autoTitle(messages) {
  const first = messages.find(m => m.role === "user");
  if (!first) return "New conversation";
  const text = first.content.trim();
  return text.length > 48 ? text.slice(0, 48).trimEnd() + "…" : text;
}

// ── Export helpers ────────────────────────────────────────────────────────────
function exportAsMarkdown(session) {
  const lines = [`# ${session.title}`, `_${new Date(session.createdAt).toLocaleString()}_`, ""];
  for (const m of session.messages) {
    if (m.role === "user") {
      lines.push(`**You:** ${m.content}`, "");
    } else if (m.role === "assistant") {
      lines.push(`**Sentri AI:**`, m.content, "");
    }
  }
  return lines.join("\n");
}

function exportAsJson(session) {
  return JSON.stringify({
    title: session.title,
    createdAt: new Date(session.createdAt).toISOString(),
    messages: session.messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(({ role, content }) => ({ role, content })),
  }, null, 2);
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeFilename(title) {
  return title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
}

// ── TypingIndicator ───────────────────────────────────────────────────────────
const TypingIndicator = memo(function TypingIndicator() {
  return (
    <div className="ch-message">
      <div className="ch-avatar ch-avatar--ai"><Bot size={14} color="#fff" /></div>
      <div className="ch-typing">
        <span className="ch-typing__dot" />
        <span className="ch-typing__dot" />
        <span className="ch-typing__dot" />
      </div>
    </div>
  );
});

// ── MessageBubble ─────────────────────────────────────────────────────────────
function MessageBubble({ msg }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(msg.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard unavailable (e.g. non-HTTPS) */ });
  }

  const isUser  = msg.role === "user";
  const isError = msg.role === "error";

  return (
    <div className={`ch-message${isUser ? " ch-message--user" : ""}`}>
      <div className={`ch-avatar ${isUser ? "ch-avatar--user" : isError ? "ch-avatar--error" : "ch-avatar--ai"}`}>
        {isUser  && <User size={14} color="#fff" />}
        {isError && <span style={{ fontSize: "0.7rem" }}>⚠</span>}
        {!isUser && !isError && <Bot size={14} color="#fff" />}
      </div>

      <div className={`ch-bubble ${isUser ? "ch-bubble--user" : isError ? "ch-bubble--error" : "ch-bubble--ai"}`}>
        {isUser ? (
          <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
        ) : (
          <div
            className="chat-md"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        )}
        {!isUser && !isError && msg.content && (
          <button className="ch-copy-btn" onClick={handleCopy} title="Copy">
            {copied
              ? <><Check size={10} color="var(--green)" /> Copied</>
              : <><Copy size={10} /> Copy</>}
          </button>
        )}
      </div>
    </div>
  );
}

// ── WelcomePrompts ────────────────────────────────────────────────────────────
const PROMPTS = [
  "Help me debug a failing Playwright test",
  "Generate test cases for a checkout flow",
  "What's the best way to handle dynamic selectors?",
  "Review my test strategy for a SaaS app",
];

const WelcomeScreen = memo(function WelcomeScreen({ onPrompt }) {
  return (
    <div className="ch-welcome">
      <div className="ch-welcome__glow" />
      <div className="ch-welcome__icon"><Sparkles size={26} color="#fff" /></div>
      <h2 className="ch-welcome__title">Sentri AI</h2>
      <p className="ch-welcome__sub">Your QA expert — ask about tests, bugs, CI/CD, or anything.</p>
      <div className="ch-welcome__prompts">
        {PROMPTS.map(p => (
          <button key={p} className="ch-welcome__prompt-btn" onClick={() => onPrompt(p)}>
            <ChevronRight size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
            {p}
          </button>
        ))}
      </div>
    </div>
  );
});

// ── ExportMenu ────────────────────────────────────────────────────────────────
function ExportMenu({ session, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  function handleMd() {
    download(exportAsMarkdown(session), `${safeFilename(session.title)}.md`, "text/markdown");
    onClose();
  }

  function handleJson() {
    download(exportAsJson(session), `${safeFilename(session.title)}.json`, "application/json");
    onClose();
  }

  return (
    <div ref={ref} className="ch-export-menu">
      <button className="ch-export-menu__item" onClick={handleMd}>
        <FileText size={14} /> Export as Markdown
      </button>
      <button className="ch-export-menu__item" onClick={handleJson}>
        <FileJson size={14} /> Export as JSON
      </button>
    </div>
  );
}

// ── SessionItem ───────────────────────────────────────────────────────────────
function SessionItem({ session, active, onSelect, onRename, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handler(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const msgCount = session.messages.filter(m => m.role === "user" || m.role === "assistant").length;
  const lastMsg  = [...session.messages].reverse().find(m => m.role === "user" || m.role === "assistant");

  return (
    <div
      className={`ch-session-item${active ? " ch-session-item--active" : ""}`}
      onClick={() => onSelect(session.id)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === "Enter" && onSelect(session.id)}
    >
      <div className="ch-session-item__icon">
        <MessageSquare size={13} />
      </div>
      <div className="ch-session-item__body">
        <div className="ch-session-item__title">{session.title}</div>
        {lastMsg && (
          <div className="ch-session-item__preview">
            {lastMsg.content.slice(0, 55)}{lastMsg.content.length > 55 ? "…" : ""}
          </div>
        )}
        <div className="ch-session-item__meta">
          {msgCount} message{msgCount !== 1 ? "s" : ""}
          {" · "}
          {new Date(session.updatedAt).toLocaleDateString()}
        </div>
      </div>

      <div className="ch-session-item__actions" onClick={e => e.stopPropagation()}>
        <button
          className="ch-session-item__menu-btn"
          title="Options"
          onClick={() => setMenuOpen(v => !v)}
        >
          <MoreHorizontal size={14} />
        </button>

        {menuOpen && (
          <div ref={menuRef} className="ch-session-menu">
            <button className="ch-session-menu__item" onClick={() => { onRename(session.id); setMenuOpen(false); }}>
              <Edit3 size={13} /> Rename
            </button>
            <div className="ch-session-menu__divider" />
            <button
              className="ch-session-menu__item ch-session-menu__item--danger"
              onClick={() => { onDelete(session.id); setMenuOpen(false); }}
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main ChatHistory page ─────────────────────────────────────────────────────
export default function ChatHistory() {
  const { user }  = useAuth();
  const userId     = user?.id ?? null;

  const [sessions,       setSessions]       = useState(() => loadSessions(userId));
  const [activeId,       setActiveId]       = useState(() => loadSessions(userId)[0]?.id ?? null);
  const [input,          setInput]          = useState("");
  const [loading,        setLoading]        = useState(false);
  const [search,         setSearch]         = useState("");
  const [renamingId,     setRenamingId]     = useState(null);
  const [renameValue,    setRenameValue]    = useState("");
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [sidebarOpen,    setSidebarOpen]    = useState(true);

  const messagesEndRef = useRef(null);
  const inputRef       = useRef(null);
  const abortRef       = useRef(null);
  const renameInputRef = useRef(null);
  const sessionsRef    = useRef(sessions);

  // Reload sessions when user changes (login/logout)
  useEffect(() => {
    const s = loadSessions(userId);
    setSessions(s);
    setActiveId(s[0]?.id ?? null);
  }, [userId]);

  // Keep ref in sync for use in sendMessage
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  // Persist on every change
  useEffect(() => { saveSessions(sessions, userId); }, [sessions, userId]);

  const activeSession = useMemo(
    () => sessions.find(s => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  const filteredSessions = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.messages.some(m => m.content?.toLowerCase().includes(q))
    );
  }, [sessions, search]);

  // Scroll to bottom (scoped to active session's message count to avoid
  // firing on renames, deletes of other sessions, search changes, etc.)
  const activeMsgCount = activeSession?.messages.length ?? 0;
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMsgCount, loading, activeId]);

  // Focus input when switching sessions
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 80);
  }, [activeId]);

  // Focus rename input
  useEffect(() => {
    if (renamingId) setTimeout(() => renameInputRef.current?.focus(), 50);
  }, [renamingId]);

  // ── Session CRUD ────────────────────────────────────────────────────────────
  function newSession() {
    const s = createSession();
    setSessions(prev => [s, ...prev]);
    setActiveId(s.id);
    setInput("");
  }

  function selectSession(id) {
    setActiveId(id);
    setInput("");
    abortRef.current?.abort();
    // Auto-close sidebar on mobile so the chat area is visible
    if (window.innerWidth <= 768) setSidebarOpen(false);
  }

  function deleteSession(id) {
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeId === id) {
      abortRef.current?.abort();
      const remaining = sessionsRef.current.filter(s => s.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
  }

  function startRename(id) {
    const found = sessions.find(s => s.id === id);
    if (!found) return;
    setRenamingId(id);
    setRenameValue(found.title);
  }

  function commitRename() {
    const title = renameValue.trim() || "Untitled";
    setSessions(prev => prev.map(s => s.id === renamingId ? { ...s, title } : s));
    setRenamingId(null);
  }

  // ── Send message ────────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text) => {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    // Ensure there's an active session
    let sid = activeId;
    if (!sid) {
      const s = createSession();
      setSessions(prev => [s, ...prev]);
      setActiveId(s.id);
      sid = s.id;
    }

    setInput("");
    const userMsg = { role: "user", content, id: Date.now() };
    const replyId = Date.now() + 1;

    // Build history for API from the ref (avoids stale closure without
    // relying on setSessions updater being synchronous)
    const currentSession = sessionsRef.current.find(s => s.id === sid);
    const history = (currentSession?.messages ?? [])
      .filter(m => m.role === "user" || m.role === "assistant")
      .concat(userMsg)
      .map(({ role, content }) => ({ role, content }));

    setSessions(prev => prev.map(s => {
      if (s.id !== sid) return s;
      const msgs = [...s.messages, userMsg, { role: "assistant", content: "", id: replyId }];
      return { ...s, messages: msgs, updatedAt: Date.now() };
    }));
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await api.chat(
        history,
        (token) => {
          setSessions(prev => prev.map(s => {
            if (s.id !== sid) return s;
            return {
              ...s,
              messages: s.messages.map(m =>
                m.id === replyId ? { ...m, content: m.content + token } : m
              ),
              updatedAt: Date.now(),
            };
          }));
        },
        (errMsg) => {
          setSessions(prev => prev.map(s => {
            if (s.id !== sid) return s;
            return {
              ...s,
              messages: s.messages.map(m =>
                m.id === replyId ? { ...m, role: "error", content: errMsg } : m
              ),
            };
          }));
        },
        controller.signal,
      );
    } catch (err) {
      if (err.name !== "AbortError") {
        let errorMsg = (err.message || "An unexpected error occurred.").replace(/^\[\d+\]\s*/, "");
        const lower = errorMsg.toLowerCase();
        if (lower.includes("failed to fetch") || lower.includes("fetch failed") || lower.includes("networkerror") || lower.includes("network error")) {
          errorMsg = "Connection lost. Check that the AI provider is configured in Settings.";
        } else if (lower.includes("session expired")) {
          errorMsg = "Your session has expired. Please sign in again.";
        }
        setSessions(prev => prev.map(s => {
          if (s.id !== sid) return s;
          return {
            ...s,
            messages: s.messages.map(m =>
              m.id === replyId ? { ...m, role: "error", content: errorMsg } : m
            ),
          };
        }));
      }
    } finally {
      abortRef.current = null;
      setLoading(false);

      // Auto-title after first exchange
      setSessions(prev => prev.map(s => {
        if (s.id !== sid) return s;
        if (s.title === "New conversation" && s.messages.some(m => m.role === "user")) {
          return { ...s, title: autoTitle(s.messages) };
        }
        return s;
      }));

      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading, activeId]);

  function stopGeneration() { abortRef.current?.abort(); }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function handleInput(e) {
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
  }

  const canSend = input.trim() && !loading;

  return (
    <div className="ch-page">

      {/* ── Sidebar ─────────────────────────────────────────────────── */}
      <aside className={`ch-sidebar${sidebarOpen ? "" : " ch-sidebar--hidden"}`}>
        <div className="ch-sidebar__header">
          <div className="ch-sidebar__title">
            <Sparkles size={15} style={{ color: "var(--accent)" }} />
            AI Chats
          </div>
          <button className="ch-sidebar__new-btn" onClick={newSession} title="New conversation">
            <Plus size={15} />
          </button>
        </div>

        <div className="ch-sidebar__search">
          <Search size={13} style={{ color: "var(--text3)", flexShrink: 0 }} />
          <input
            className="ch-sidebar__search-input"
            placeholder="Search conversations…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", display: "flex" }}
              onClick={() => setSearch("")}
              aria-label="Clear search"
              title="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="ch-sidebar__list">
          {filteredSessions.length === 0 && (
            <div className="ch-sidebar__empty">
              {search ? "No results" : "No conversations yet"}
            </div>
          )}
          {filteredSessions.map(s => (
            renamingId === s.id ? (
              <div key={s.id} className="ch-rename-row">
                <input
                  ref={renameInputRef}
                  className="ch-rename-input"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={commitRename}
                />
              </div>
            ) : (
              <SessionItem
                key={s.id}
                session={s}
                active={s.id === activeId}
                onSelect={selectSession}
                onRename={startRename}
                onDelete={deleteSession}
              />
            )
          ))}
        </div>
      </aside>

      {/* ── Chat area ────────────────────────────────────────────────── */}
      <div className="ch-main">

        {/* Topbar */}
        <div className="ch-topbar">
          <button
            className="ch-topbar__toggle"
            onClick={() => setSidebarOpen(v => !v)}
            title="Toggle sidebar"
          >
            <MessageSquare size={16} />
          </button>

          <div className="ch-topbar__title">
            {activeSession ? activeSession.title : "Sentri AI"}
          </div>

          {activeSession && activeSession.messages.length > 0 && (
            <div style={{ position: "relative", marginLeft: "auto" }}>
              <button
                className="ch-topbar__action"
                onClick={() => setExportMenuOpen(v => !v)}
                title="Export chat"
              >
                <Download size={15} />
                Export
              </button>
              {exportMenuOpen && (
                <ExportMenu
                  session={activeSession}
                  onClose={() => setExportMenuOpen(false)}
                />
              )}
            </div>
          )}

          {activeSession && (
            <button
              className="ch-topbar__action ch-topbar__action--danger"
              onClick={() => deleteSession(activeId)}
              title="Delete this conversation"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="ch-messages">
          {!activeSession || activeSession.messages.length === 0 ? (
            <WelcomeScreen onPrompt={text => { setInput(text); inputRef.current?.focus(); }} />
          ) : (
            <>
              {activeSession.messages.map(msg => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}
              {loading && <TypingIndicator />}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input */}
        <div className="ch-input-wrap">
          <div className="ch-input-row">
            <textarea
              ref={inputRef}
              className="ch-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              placeholder="Ask anything about testing, bugs, CI/CD…"
              disabled={loading}
              rows={1}
            />
            {loading ? (
              <button className="ch-send-btn ch-send-btn--stop" onClick={stopGeneration} title="Stop">
                <Square size={13} />
              </button>
            ) : (
              <button
                className={`ch-send-btn ${canSend ? "ch-send-btn--active" : "ch-send-btn--inactive"}`}
                onClick={() => sendMessage()}
                disabled={!canSend}
                title="Send (Enter)"
              >
                <Send size={15} />
              </button>
            )}
          </div>
          <div className="ch-input-hint">Shift+Enter for new line · Enter to send</div>
        </div>
      </div>
    </div>
  );
}
