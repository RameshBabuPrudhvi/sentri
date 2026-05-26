import React, { useCallback } from "react";
import {
  Activity, Clock, Database, Shield,
} from "lucide-react";
import { api } from "../../../../api.js";
import { invalidateSettingsCache } from "../../../../queryClient.js";
import { useSettingsBundleQuery } from "../../../../hooks/queries/useSettingsQueries.js";
import SectionTitle from "../../shared/SectionTitle.jsx";
import DataAction from "../../shared/DataAction.jsx";
import RecycleBinPanel from "./RecycleBinPanel.jsx";

/**
 * Data section — clear-history actions (runs, activity log, healing history)
 * plus the recycle bin. All actions are admin-gated; the routes layer enforces
 * `requireRole("admin")` so non-admins never reach this section.
 * Extracted from Settings.jsx (GAP-002).
 */
export default function DataSection() {
  const bundleQuery = useSettingsBundleQuery();
  const sysInfo = bundleQuery.data?.sysInfo ?? null;
  const reload = useCallback(() => invalidateSettingsCache(), []);

  return (
    <>
      <SectionTitle
        icon={<Database size={16} color="var(--amber)" />}
        title="Data Management"
        sub="Clear in-memory data — all data is ephemeral and resets on server restart"
      />
      <div className="flex-col gap-md">
        <DataAction
          icon={<Activity size={16} />}
          label="Run History"
          sub="All crawl and test run records, including logs and results"
          count={sysInfo?.runs}
          btnLabel="Clear Runs"
          onAction={async () => { const r = await api.clearRuns(); await reload(); return r; }}
        />
        <DataAction
          icon={<Clock size={16} />}
          label="Activity Log"
          sub="Timeline of all user and system actions"
          count={sysInfo?.activities}
          btnLabel="Clear Log"
          onAction={async () => { const r = await api.clearActivities(); await reload(); return r; }}
        />
        <DataAction
          icon={<Shield size={16} />}
          label="Self-Healing History"
          sub="Learned selector strategies — clearing forces the waterfall to start fresh"
          count={sysInfo?.healingEntries}
          btnLabel="Clear History"
          onAction={async () => { const r = await api.clearHealing(); await reload(); return r; }}
        />
      </div>
      <div className="execution-gap" />
      <RecycleBinPanel />
    </>
  );
}
