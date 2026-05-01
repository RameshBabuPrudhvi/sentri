/**
 * @module components/project/ProjectExportMenu
 * @description Shared export dropdown for test exports. Offers the same
 * three targets available on ProjectDetail (Zephyr Scale CSV, TestRail CSV,
 * Playwright project ZIP) plus approved-only variants for the CSV formats.
 *
 * Extracted from ProjectHeader.jsx so Tests page can reuse the same menu
 * without duplicating the formats list or the download call sites.
 *
 * @param {Object} props
 * @param {string} props.projectId       - Project to export.
 * @param {number} props.totalTests       - Total test count (hides menu when 0).
 * @param {number} [props.approvedCount]  - Approved-only section shown when > 0.
 * @param {string} [props.label]          - Button label (default "Export").
 * @param {string} [props.buttonClassName] - Button className (default "btn btn-ghost btn-xs").
 */

import React, { useState } from "react";
import { Download, ChevronDown } from "lucide-react";
import { api } from "../../api.js";

const FORMATS = [
  { label: "Zephyr Scale CSV", desc: "Zephyr Scale / Zephyr Squad import", format: "zephyr" },
  { label: "TestRail CSV",     desc: "TestRail bulk import",               format: "testrail" },
];

export default function ProjectExportMenu({
  projectId,
  totalTests,
  approvedCount = 0,
  label = "Export",
  buttonClassName = "btn btn-ghost btn-xs",
}) {
  const [open, setOpen] = useState(false);
  if (!projectId || !totalTests) return null;

  return (
    <div style={{ position: "relative" }}>
      <button
        className={buttonClassName}
        onClick={() => setOpen(v => !v)}
        style={{ gap: 4 }}
      >
        <Download size={11} /> {label} <ChevronDown size={10} />
      </button>
      {open && (
        <>
          <div className="pd-popover-backdrop" onClick={() => setOpen(false)} />
          <div className="pd-dropdown" style={{ top: "calc(100% + 4px)", right: 0 }}>
            <div className="pd-dropdown-heading">
              Export all {totalTests} tests
            </div>
            {FORMATS.map(fmt => (
              <button
                key={fmt.label}
                onClick={() => { setOpen(false); api.downloadExport(projectId, fmt.format); }}
                className="pd-dropdown-item"
                style={{ background: "none", border: "none", width: "100%", textAlign: "left", cursor: "pointer" }}
              >
                <div className="pd-dropdown-item-title">{fmt.label}</div>
                <div className="pd-dropdown-item-desc">{fmt.desc}</div>
              </button>
            ))}
            {/* DIF-006: Standalone Playwright project ZIP. The endpoint always
                filters to approved tests server-side — the desc line calls
                that out so users aren't surprised that drafts/rejected tests
                are excluded regardless of which stat opened the dropdown. */}
            <button
              onClick={() => { setOpen(false); api.downloadPlaywrightExport(projectId); }}
              className="pd-dropdown-item"
              style={{ background: "none", border: "none", width: "100%", textAlign: "left", cursor: "pointer" }}
            >
              <div className="pd-dropdown-item-title">Playwright project ZIP</div>
              <div className="pd-dropdown-item-desc">Runnable Playwright project (approved tests only)</div>
            </button>
            {approvedCount > 0 && (
              <>
                <hr className="divider" style={{ margin: "4px 0" }} />
                <div className="pd-dropdown-heading">
                  Approved only ({approvedCount})
                </div>
                {FORMATS.map(fmt => (
                  <button
                    key={fmt.label}
                    onClick={() => { setOpen(false); api.downloadExport(projectId, fmt.format, "approved"); }}
                    className="pd-dropdown-item"
                    style={{ background: "none", border: "none", width: "100%", textAlign: "left", cursor: "pointer", padding: "7px 12px", fontSize: "0.82rem" }}
                  >
                    {fmt.label.replace(" Scale", "")} (approved)
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
