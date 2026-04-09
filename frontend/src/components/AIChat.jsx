/**
 * AIChat.jsx — AI chat panel for Sentri
 *
 * Triggered from the global search bar (TopBar) or ⌘K shortcut.
 * Streams responses through the backend `/api/chat` endpoint, which
 * uses whatever AI provider is configured in Settings — no direct
 * API calls from the frontend.
 *
 * Styling: CSS classes from `styles/features/chat.css` only.
 * No inline `style={{}}` props except for dynamic values that cannot
 * be expressed as static classes (textarea auto-height).
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  X, Send, Bot, User, Sparkles, Trash2, Copy, Check,
  Maximize2, Minimize2, Bug, TestTube, Shield, BarChart2,
  Zap, Terminal,
} from "lucide-react";
import { api } from "../api.js";

// ── Suggested prompts shown on the welcome screen ────────────────────────────
const SUGGESTIONS = [
  { icon: Bug,       label: "Debug failing test",      text: "Help me debug why my test is failing. It passed before but now it's timing out." },
  { icon: TestTube,  label: "Generate test cases",     text: "Generate comprehensive test cases for a user login flow including edge cases." },
  { icon: Shield,    label: "Security best practices", text: "What security tests should I add for my authentication endpoints?" },
  { icon: BarChart2, label: "Analyze test results",    text: "My test pass rate dropped from 95% to 78% this week. Help me understand why." },
  { icon: Zap,       label: "Optimize slow tests",     text: "How can I optimize my test suite that currently takes 15 minutes to run?" },
  { icon: Terminal,  label: "Write Playwright script",  text: "Write a Playwright script to test a multi-step checkout process." },
];

// ── Lightweight markdown renderer ─────────────────────────────────────────────
// Security: escapes ALL text before applying markdown transforms so any HTML
// in AI responses (e.g. <script>, <img onerror=…>) is neutralised before
// reaching dangerouslySetInnerHTML. Code blocks are extracted first, escaped
// separately, and restored via placeholders after the markdown pass.

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text) {
  // 1. Extract fenced code blocks → placeholders (already escaped)
  const codeBlocks = [];
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre data-lang="${lang || ""}"><code>${escapeHtml(code.trim())}</code></pre>`);
    return `\x00CODE${idx}\x00`;
  });

  // 2. Extract inline code → placeholders (already escaped)
  text = text.replace(/`([^`]+)`/g, (_, c) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<code>${escapeHtml(c)}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  // 3. Escape everything else — prevents XSS from AI-generated HTML
  text = escapeHtml(text);

  // 4. Apply markdown transforms on the now-safe text
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g,     "<em>$1</em>");
  text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^## (.+)$/gm,  "<h2>$1</h2>");
  text = text.replace(/^# (.+)$/gm,   "<h1>$1</h1>");
  text = text.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  text = text.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  text = text.split(/\n\n+/).map(p =>
    p.startsWith("<") ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`
  ).join("");

  // 5. Restore code block placeholders
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeBlocks[idx]);
  return text;
}

// ── MessageBubble ─────────────────────────────────────────────────────────────
function MessageBubble({ msg }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(msg.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const isUser  = msg.role === "user";
  const isError = msg.role === "error";
  const avatarMod = isUser ? "user" : isError ? "error" : "assistant";
  const bubbleMod = isUser ? "user" : isError ? "error" : "assistant";

  return (
    <div className={`chat-message${isUser ? " chat-message--user" : ""}`}>
      <div className={`chat-message__avatar chat-message__avatar--${avatarMod}`}>
        {isUser  && <User size={14} color="#fff" />}
        {isError && <span style={{ fontSize: "0.75rem" }}>⚠️</span>}
        {!isUser && !isError && <Bot size={14} color="#fff" />}
      </div>

      <div className={`chat-message__bubble chat-message__bubble--${bubbleMod}`}>
        {isUser ? (
          <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
        ) : (
          <div
            className="chat-md"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        )}

        {!isUser && !isError && msg.content && (
          <button className="chat-copy-btn" onClick={handleCopy} title="Copy response">
            {copied
              ? <><Check size={10} color="var(--green)" /> Copied</>
              : <><Copy size={10} /> Copy</>}
          </button>
        )}
      </div>
    </div>
  );
}

// ── TypingIndicator ───────────────────────────────────────────────────────────
function TypingIndicator() {
  return (
    <div className="chat-typing">
      <div className="chat-message__avatar chat-message__avatar--assistant">
        <Bot size={14} color="#fff" />
      </div>
      <div className="chat-typing__bubble">
        <span className="chat-typing__dot" />
        <span className="chat-typing__dot" />
        <span className="chat-typing__dot" />
      </div>
    </div>
  );
}

// ── WelcomeScreen ─────────────────────────────────────────────────────────────
function WelcomeScreen({ onSuggest }) {
  return (
    <div className="chat-welcome">
      <div className="chat-welcome__icon">
        <Sparkles size={24} color="#fff" />
      </div>
      <div className="chat-welcome__title">How can I help you today?</div>
      <div className="chat-welcome__subtitle">
        I'm your QA expert — ask me about tests, bugs, CI/CD, or anything.
      </div>
      <div className="chat-suggestions">
        {SUGGESTIONS.map(({ icon: Icon, label, text }) => (
          <button
            key={label}
            className="chat-suggestion-btn"
            onClick={() => onSuggest(text)}
          >
            <Icon size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── AIChat ────────────────────────────────────────────────────────────────────
export default function AIChat({ isOpen, onClose, initialQuery = "" }) {
  const [messages,  setMessages]  = useState([]);
  const [input,     setInput]     = useState("");
  const [loading,   setLoading]   = useState(false);
  const [expanded,  setExpanded]  = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef       = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
      if (initialQuery) setInput(initialQuery);
    }
  }, [isOpen, initialQuery]);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape" && isOpen) onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const sendMessage = useCallback(async (text) => {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    setInput("");
    const userMsg    = { role: "user", content, id: Date.now() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setLoading(true);

    const replyId = Date.now() + 1;
    setMessages(prev => [...prev, { role: "assistant", content: "", id: replyId }]);

    try {
      await api.chat(
        nextMessages.filter(m => m.role !== "error").map(({ role, content }) => ({ role, content })),
        (token) => {
          setMessages(prev => prev.map(m =>
            m.id === replyId ? { ...m, content: m.content + token } : m
          ));
        },
        (errMsg) => {
          setMessages(prev => prev.map(m =>
            m.id === replyId ? { ...m, role: "error", content: errMsg } : m
          ));
        }
      );
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === replyId
          ? { ...m, role: "error", content: `Something went wrong: ${err.message}. Make sure an AI provider is configured in Settings.` }
          : m
      ));
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading, messages]);

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function handleInput(e) {
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
  }

  function clearChat() {
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
  }

  if (!isOpen) return null;

  const canSend = input.trim() && !loading;
  const exchangeCount = Math.ceil(messages.length / 2);

  return (
    <>
      <div className="chat-backdrop" onClick={onClose} />

      <div className={`chat-panel${expanded ? " chat-panel--expanded" : ""}`}>

        {/* Header */}
        <div className="chat-header">
          <div className="chat-header__avatar">
            <Sparkles size={15} color="#fff" />
          </div>
          <div className="flex-col">
            <div className="chat-header__title">Sentri AI</div>
            <div className="chat-header__subtitle">
              QA assistant ·{" "}
              {exchangeCount > 0
                ? `${exchangeCount} exchange${exchangeCount > 1 ? "s" : ""}`
                : "ready to help"}
            </div>
          </div>

          <div className="chat-header__actions">
            {messages.length > 0 && (
              <button className="chat-icon-btn" onClick={clearChat} title="Clear conversation">
                <Trash2 size={14} />
              </button>
            )}
            <button
              className="chat-icon-btn"
              onClick={() => setExpanded(v => !v)}
              title={expanded ? "Minimize" : "Expand"}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button className="chat-icon-btn" onClick={onClose} title="Close (Esc)">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="chat-messages">
          {messages.length === 0 ? (
            <WelcomeScreen onSuggest={text => { setInput(text); inputRef.current?.focus(); }} />
          ) : (
            <>
              {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
              {loading && <TypingIndicator />}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input */}
        <div className="chat-input-area">
          <div className="chat-input-row">
            <textarea
              ref={inputRef}
              className="chat-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              placeholder="Ask anything about testing, debugging, CI/CD…"
              disabled={loading}
              rows={1}
            />
            <button
              className={`chat-send-btn ${canSend ? "chat-send-btn--active" : "chat-send-btn--inactive"}`}
              onClick={() => sendMessage()}
              disabled={!canSend}
              title="Send (Enter)"
            >
              <Send size={14} />
            </button>
          </div>
          <div className="chat-input-hint">
            Shift+Enter for new line · Enter to send · Esc to close
          </div>
        </div>
      </div>
    </>
  );
}
