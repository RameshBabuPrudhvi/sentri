/**
 * CopyButton — reusable copy-to-clipboard button with "Copied" feedback.
 *
 * @param {{ text: string, className?: string }} props
 */

import { useState } from "react";
import { Copy, Check } from "lucide-react";

export default function CopyButton({ text, className = "btn btn-ghost btn-xs" }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard unavailable (non-HTTPS, denied permission) */ });
  };
  return (
    <button className={className} onClick={copy} title="Copy to clipboard">
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
