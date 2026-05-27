/**
 * @module hooks/useTestLabAttachments
 * @description Owns the Test Lab Requirement composer's attachment state
 *   machine: text-file uploads + the inline Jira/issue import panel.
 *   Encapsulates `attachments`, `showImportIssue`, `importIssueText`, the
 *   hidden file-input ref, and the three handlers that mutate them.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 * decomposition (audit §3.1, pass 3). The page used to inline 75+ lines
 * of file-reader plumbing + binary-detection + prompt-injection stripping
 * directly inside the component body. Pulling it into a hook keeps the
 * page focused on the run-lifecycle state machine and makes the
 * attachment logic unit-testable without a renderer.
 *
 * Why a hook (not a util module): the binary-detection guard and the
 * prompt-injection sanitiser run inside the `FileReader.onload` callback,
 * which means they read/write React state (`attachments`, `error`). A
 * pure util can't own that lifecycle without leaking `useState` setters
 * through its signature.
 *
 * Dependencies flow IN from the page:
 *   - `setError(msg)` — surfaces user-facing validation failures
 *     (binary file, size cap, dedup check). The page owns the error
 *     banner so this hook does not render its own UI.
 *   - `setTestName(str)` / `setRequirement(updater)` — only the
 *     `handleImportIssue` flow writes these. Passed in instead of
 *     duplicating state because the launch payload (in the page) needs
 *     the same `testName` / `requirement` values.
 *   - `clearError()` — called when the Import-issue panel successfully
 *     commits, mirroring the page's existing `if (error) setError(null)`
 *     guard so a stale error doesn't outlive the recovery action.
 */
import { useRef, useState } from "react";
import {
  MAX_ATTACHMENT_SIZE,
  MAX_TOTAL_ATTACHMENT,
  isTextMime,
} from "../utils/testLabAttachments.js";

export default function useTestLabAttachments({
  setError,
  setTestName,
  setRequirement,
  clearError,
}) {
  // Plain-text attachments folded into the AI prompt's `description`.
  // Mirrors GenerateTestModal — same 40 KB / 45 KB caps, same MIME
  // allowlist (see `frontend/src/utils/testLabAttachments.js`).
  const [attachments, setAttachments] = useState([]); // [{ name, content }]
  const [showImportIssue, setShowImportIssue] = useState(false);
  const [importIssueText, setImportIssueText] = useState("");
  const fileInputRef = useRef(null);

  // Read user-supplied text files into memory so we can fold them into the
  // requirement when launching. Each file is MIME-checked and binary-scanned
  // (>5% non-printable bytes in the first 1 KB → reject) before being added,
  // and we strip common prompt-injection markers (matches the backend
  // `testDials.js` sanitisation).
  function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // allow re-selecting the same file after removal
    for (const file of files) {
      if (!isTextMime(file)) {
        setError(`"${file.name}" appears to be a binary file (${file.type || "unknown type"}). Only text-based files are supported.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_SIZE) {
        setError(`"${file.name}" is too large (${Math.round(file.size / 1000)} KB). Max is 40 KB per file.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const raw = reader.result;
        const sample = raw.slice(0, 1024);
        const nonPrintable = [...sample].filter(c => {
          const code = c.charCodeAt(0);
          return code < 32 && code !== 9 && code !== 10 && code !== 13;
        }).length;
        if (sample.length > 0 && nonPrintable / sample.length > 0.05) {
          setError(`"${file.name}" contains binary data and cannot be used as a text attachment.`);
          return;
        }
        const content = raw
          .replace(/^(SYSTEM|ASSISTANT|USER|HUMAN|AI)\s*:/gim, "")
          .replace(/```/g, "");
        setAttachments(prev => {
          if (prev.some(a => a.name === file.name)) return prev;
          const totalSize = prev.reduce((n, a) => n + a.content.length, 0) + content.length;
          if (totalSize > MAX_TOTAL_ATTACHMENT) {
            setError("Total attachment size would exceed 45 KB. Remove an existing file first.");
            return prev;
          }
          return [...prev, { name: file.name, content }];
        });
      };
      reader.onerror = () => setError(`Failed to read "${file.name}".`);
      reader.readAsText(file);
    }
  }

  function removeAttachment(fileName) {
    setAttachments(prev => prev.filter(a => a.name !== fileName));
  }

  // Parse pasted Jira issue text into name + description. Accepts:
  //   "PROJ-123 Login fails for SSO users\nAs a user…"
  //   "Login fails for SSO users\nAs a user…"
  function handleImportIssue() {
    const raw = importIssueText.trim();
    if (!raw) return;
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || "";
    const parsedName = firstLine.replace(/^[A-Z][A-Z0-9]+-\d+\s*[-:.]?\s*/, "").trim();
    const parsedDesc = lines.slice(1).join("\n").trim();
    if (parsedName) setTestName(parsedName);
    if (parsedDesc) setRequirement(prev => prev ? `${prev}\n\n${parsedDesc}` : parsedDesc);
    setImportIssueText("");
    setShowImportIssue(false);
    clearError();
  }

  return {
    attachments,
    setAttachments,
    showImportIssue,
    setShowImportIssue,
    importIssueText,
    setImportIssueText,
    fileInputRef,
    handleFileSelect,
    removeAttachment,
    handleImportIssue,
  };
}
