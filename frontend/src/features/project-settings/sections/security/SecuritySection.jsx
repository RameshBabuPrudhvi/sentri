import React from "react";
import { useProjectSettings } from "../../components/ProjectSettingsContext.js";
import PiiFirewallPanel from "./PiiFirewallPanel.jsx";

/**
 * Security section — PII firewall + per-project privacy controls.
 *
 * Replaces the legacy "PII Firewall" inner tab from `ProjectQualityCard`.
 * Panel co-located at `./PiiFirewallPanel.jsx`.
 */
export default function SecuritySection() {
  const { project, canEdit, onToast } = useProjectSettings();
  return (
    <div className="ps-section">
      <section className="ps-section__block">
        <h2 className="ps-section__title">PII Firewall</h2>
        <p className="ps-section__desc">
          Strips emails, phone numbers, SSNs, Luhn-checked credit cards, JWTs,
          Bearer/Basic auth headers, and token query params from crawl
          snapshots before they reach the LLM prompt builder.
        </p>
        <PiiFirewallPanel
          project={project}
          canEdit={canEdit}
          onToast={onToast}
        />
      </section>
    </div>
  );
}
