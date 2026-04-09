import React from "react";
import { Bot, MessageCircle, Send, X } from "lucide-react";
import { api } from "../api.js";

const SUGGESTIONS = [
  "Give me a smoke test checklist for a new login flow",
  "How can I reduce flaky UI tests in this project?",
  "Draft 5 high-value tests for an e-commerce checkout",
];

export default function AIChat() {
  const [isOpen, setIsOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState([
    {
      role: "assistant",
      content: "Hi! I can help with QA strategy, test ideas, and debugging flaky runs.",
    },
  ]);
  const [isStreaming, setIsStreaming] = React.useState(false);
  const viewportRef = React.useRef(null);
  const textareaRef = React.useRef(null);

  React.useEffect(() => {
    if (!viewportRef.current) return;
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [messages, isStreaming]);

  function resizeTextarea(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function applySuggestion(text) {
    setInput(text);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        resizeTextarea(textareaRef.current);
      }
    });
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMessage = { role: "user", content: text };
    const next = [...messages, userMessage];
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "40px";
    setIsStreaming(true);

    try {
      await api.chat(next, (token) => {
        setMessages((curr) => {
          const updated = [...curr];
          const idx = updated.length - 1;
          const current = updated[idx];
          updated[idx] = { ...current, content: `${current.content}${token}` };
          return updated;
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat failed";
      setMessages((curr) => {
        const updated = [...curr];
        const idx = updated.length - 1;
        updated[idx] = {
          role: "assistant",
          content: `I hit an error: ${message}`,
        };
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <>
      <button className="chat-trigger" onClick={() => setIsOpen(true)} aria-label="Open AI chat">
        <MessageCircle size={16} />
        Ask AI
        <span className="chat-trigger_placeholder">⌘</span>
        <span className="chat-trigger_kbd">K</span>
      </button>

      {isOpen && <button className="chat-backdrop" aria-label="Close AI chat" onClick={() => setIsOpen(false)} />}

      <section className={`chat-panel ${isOpen ? "chat-panel--open" : ""}`} aria-hidden={!isOpen}>
        <header className="chat-header">
          <div className="chat-title-wrap">
            <div className="chat-avatar"><Bot size={15} /></div>
            <div>
              <h3 className="chat-title">Sentri Assistant</h3>
              <p className="chat-subtitle">Provider auto-routed via backend</p>
            </div>
          </div>
          <button className="chat-close" onClick={() => setIsOpen(false)} aria-label="Close panel">
            <X size={16} />
          </button>
        </header>

        <div className="chat-viewport" ref={viewportRef}>
          <div className="chat-suggestions">
            {SUGGESTIONS.map((item) => (
              <button key={item} className="chat-suggestion" onClick={() => applySuggestion(item)}>{item}</button>
            ))}
          </div>

          {messages.map((msg, i) => (
            <div key={`${msg.role}-${i}`} className={`chat-bubble chat-bubble--${msg.role}`}>
              {msg.content || (msg.role === "assistant" && isStreaming ? <TypingDots /> : "")}
            </div>
          ))}
        </div>

        <footer className="chat-input-row">
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              resizeTextarea(e.currentTarget);
            }}
            onKeyDown={onKeyDown}
            placeholder="Ask for test ideas, risk analysis, or debugging help..."
            rows={1}
            style={{ height: 40 }}
          />
          <button className="chat-send" onClick={handleSend} disabled={!input.trim() || isStreaming}>
            <Send size={15} />
          </button>
        </footer>
      </section>
    </>
  );
}

function TypingDots() {
  return (
    <span className="chat-typing" aria-label="Assistant is typing">
      <span className="chat-dot" />
      <span className="chat-dot" />
      <span className="chat-dot" />
    </span>
  );
}
