/**
 * @module utils/testLabAttachments
 * @description Attachment limits + MIME guard for the Test Lab requirement
 *   composer. Mirrors the legacy GenerateTestModal contract (40 KB per file,
 *   45 KB total — backend caps `description` at 50 KB so we leave headroom
 *   for the prompt scaffold). Same MIME-allowlist + binary-detection guards
 *   prevent users from pasting screenshots / PDFs that would blow up token
 *   counts.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 *   decomposition (audit §3.1). Kept as a pure module — no React imports —
 *   so the constants can be referenced from anywhere (e.g. a future
 *   `<AttachmentPicker>` component) without dragging in TestLab's render
 *   tree.
 */

export const ACCEPTED_EXTENSIONS = ".txt,.md,.csv,.json,.xml,.html,.yml,.yaml,.feature,.gherkin";
export const MAX_ATTACHMENT_SIZE  = 40_000;
export const MAX_TOTAL_ATTACHMENT = 45_000;

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/x-yaml", "application/yaml"];
const TEXT_MIME_EXACT    = new Set([
  "text/plain", "text/csv", "text/html", "text/markdown", "text/xml", "text/yaml",
  "application/json", "application/xml", "application/x-yaml", "application/yaml",
]);

/**
 * Returns true if `file.type` is in the text-MIME allowlist, OR if the file
 * has no detectable MIME (e.g. `.feature`, `.gherkin`) — those are accepted
 * because the OS file picker has already filtered against
 * `ACCEPTED_EXTENSIONS`.
 *
 * @param {File} file
 * @returns {boolean}
 */
export function isTextMime(file) {
  const mime = (file.type || "").toLowerCase();
  if (!mime) return true;
  if (TEXT_MIME_EXACT.has(mime)) return true;
  return TEXT_MIME_PREFIXES.some(p => mime.startsWith(p));
}
