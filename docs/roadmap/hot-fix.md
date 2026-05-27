# UX Fix: Restore Success/Failure Feedback on Save/Update/Delete Actions
## Problem
Across the app, users click **Save / Update / Delete** on configuration forms and receive **no visible feedback**. Three inconsistent patterns have drifted apart:
1. **`showToast(...)` local state** — used in `frontend/src/pages/ProjectDetail.jsx:130-133`. ✅ Works.
2. **`onToast` callback prop** — wired correctly in `ProjectDetail.jsx:618` (to `showToast`), but in `frontend/src/pages/Automation.jsx:68-73` it's wired to `addNotification()` (the notification bell, NOT a visible toast). ❌ Silent.
3. **`setStatus({type, text})` inline banner** — used inconsistently in `frontend/src/features/settings/sections/*`. Some sections set success status, most do not.
## Root cause (single most impactful bug)
`frontend/src/pages/Automation.jsx:68-73`:
```jsx
const onPanelToast = useCallback((msg, type = "info") => {
  addNotification({
    type: type === "error" ? "error" : type === "success" ? "success" : "info",
    title: msg,
  });
}, [addNotification]);
```
This routes every `onToast` from `ProjectQualityCard`, `AutoApprovalPanel`, `CoveragePanel`, `QualityGatesPanel`, `WebVitalsBudgetsPanel`, etc. to the **notification bell** instead of a visible toast. That's why setting Auto-Approval to 0.8 and clicking Save shows no message — the panel does emit `onToast?.({ type: "success", message: "Auto-approval threshold set to 0.8." })` at `ProjectQualityCard.jsx:264`, but the parent swallows it.
---
## Files with confirmed missing/broken success feedback
### 🔴 Critical — silent saves (user reported)
| # | File | Function | Issue |
|---|------|----------|-------|
| 1 | `frontend/src/pages/Automation.jsx:68-73` | `onPanelToast` | Routes `onToast` to `addNotification` (bell), not a visible toast. **Root cause** of Auto-Approval / Quality Gates / Web Vitals / Coverage "no message" bug. |
| 2 | `frontend/src/components/automation/ProjectQualityCard.jsx:263-264` | `AutoApprovalPanel.save` | Emits `onToast?.({ type: "success", ... })` correctly — swallowed by #1. |
| 3 | `frontend/src/components/automation/ProjectQualityCard.jsx:81-99` | `CoveragePanel.save` | Emits toast correctly — swallowed by #1. |
| 4 | `frontend/src/components/automation/ProjectQualityCard.jsx:167, 290, 433, 552` | other `save` handlers | Emit `onToast` — swallowed by #1. Audit each. |
| 5 | `frontend/src/pages/NewProject.jsx:144-186` | `submit` | Silently calls `invalidateProjectDataCache()` and navigates. No toast on create or edit. Only `setError` on failure. |
### 🟡 Settings sections — silent success (inconsistent `setStatus` usage, never `showToast`)
| # | File | Function (line) | Issue |
|---|------|-----------------|-------|
| 6  | `frontend/src/features/settings/sections/agent-roles/AgentRolesSection.jsx:88-111` | `save` | Only `setError` on failure. **No success feedback** after create/update. |
| 7  | `frontend/src/features/settings/sections/agent-roles/AgentRolesSection.jsx:125-134` | `del` | No success feedback on delete. |
| 8  | `frontend/src/features/settings/sections/provider-routes/ProviderRoutesSection.jsx:82` | `save` | Likely silent on success — audit. |
| 9  | `frontend/src/features/settings/sections/provider-routes/ProviderRoutesSection.jsx:150` | delete handler | Likely silent on success — audit. |
| 10 | `frontend/src/features/settings/sections/providers/ProvidersSection.jsx:31-39` | `handleSave` / `handleDelete` | API-key save/delete — no toast. |
| 11 | `frontend/src/features/settings/sections/providers/CompatProviderForm.jsx:48` | `handleSave` | OpenAI-compat slot save — no toast. |
| 12 | `frontend/src/features/settings/sections/integrations/IntegrationsSection.jsx:76` | `saveRow` (`api.updateGithubCheckSettings`) | Sets `setStatus` only on GitHub-App install flow (line 53); `saveRow` itself silent. |
| 13 | `frontend/src/features/settings/sections/members/MembersSection.jsx:59` | role update (`api.updateMemberRole`) | No `setStatus` / toast anywhere — silent. |
| 14 | `frontend/src/features/settings/sections/account/AccountSection.jsx:57-80` | `handleDelete` | Audit — destructive path should toast before redirect/logout. |
### 🟢 Already correct — keep as reference
- `frontend/src/components/project/EnvironmentsTab.jsx:75` — `handleSave` calls `onToast?.("Environment updated", "success")` and `ProjectDetail.jsx:618` wires `onToast={showToast}`. ✅
- `frontend/src/components/project/ConfigurablePanel.jsx:146-189` — Quality Gates & Web Vitals via `handleSave`/`handleClear` emit `showToast` through `onToast`. ✅ on `ProjectDetail`, ❌ on `Automation` (swallowed by #1).
- `frontend/src/pages/ProjectDetail.jsx:130-262, 569-571` — local `showToast` works.
- `frontend/src/features/settings/sections/security/WorkspaceMfaPolicyPanel.jsx:47-58` — uses `setStatus({type:"ok"})`. ✅
- `frontend/src/features/settings/sections/provider-routes/WorkspaceSpendCapsPanel.jsx:44-65` — uses `setStatus({type:"ok"})`. ✅
- `frontend/src/features/settings/sections/providers/ProviderCard.jsx:61-75` — uses `setStatus("saved")` with 3s timeout. ✅
### ❓ To audit (likely missing feedback)
- `frontend/src/pages/TestDetail.jsx` — `handleSaveEdit` (referenced at line 348). Confirm success toast after `api.updateTest`.
- Run a sweep:
  ```bash
  grep -rn "await api\.\(update\|create\|delete\|save\|patch\|put\|post\)" \
      frontend/src --include="*.jsx"
  ```
  Every result must have a sibling `showToast` / `onToast` / `setStatus({type:"ok"})`.
---
## Proposed fix (single PR)
### Step 1 — Introduce a global `ToastContext`
Create `frontend/src/context/ToastContext.jsx`. Reuse the visual from `ProjectDetail.jsx:130-133`. API:
```jsx
const { showToast } = useToast();
showToast("Saved", "success");
```
Mount `<ToastProvider>` once in `frontend/src/App.jsx` above `<Routes>`.
### Step 2 — Fix `Automation.jsx:68-73`
```jsx
const { showToast } = useToast();
const onPanelToast = useCallback((msg, type = "info") => {
  // Panels emit either `(msg, type)` or `({ type, message })` — normalize.
  if (typeof msg === "object" && msg !== null) showToast(msg.message, msg.type);
  else showToast(msg, type);
}, [showToast]);
```
Keep `addNotification` only for events that belong in the bell (run-complete, scheduled-trigger fired). Also decide on a single `onToast` signature and fix all callsites to match (`ProjectQualityCard` uses `{ type, message }`; `EnvironmentsTab` and `ConfigurablePanel` use `(msg, type)`).
### Step 3 — Fix `NewProject.jsx:144-186`
Add a toast before `navigate(...)`:
```jsx
if (isEdit) {
  await api.updateProject(editId, payload);
  invalidateProjectDataCache();
  showToast("Project updated", "success");
  navigate(`/projects/${editId}`);
} else {
  const project = await api.createProject(payload);
  invalidateProjectDataCache();
  emitTourEvent("project-created");
  showToast("Project created", "success");
  navigate(`/projects/${project.id}`);
}
```
Also add `showToast(err.message, "error")` in the `catch`.
### Step 4 — Migrate the silent settings sections
For each file in the 🟡 list, add success+error toast. Example for `AgentRolesSection.jsx:88-111`:
```jsx
async function save(e) {
  e.preventDefault();
  setError("");
  setBusy(true);
  try {
    const payload = { /* ... */ };
    if (editingRole) await api.updateAgentRole(editingRole, payload);
    else             await api.createAgentRole(payload);
    setEditingRole("");
    setForm(EMPTY_FORM);
    await load();
    showToast(editingRole ? "Agent role updated" : "Agent role saved", "success");
  } catch (err) {
    setError(err.message || "Failed to save agent role.");
    showToast(err.message || "Failed to save agent role.", "error");
  } finally {
    setBusy(false);
  }
}
```
Apply the same pattern to:
- `AgentRolesSection.del` → `"Agent role deleted"`
- `ProviderRoutesSection.save` / delete → `"Provider route saved/deleted"`
- `ProvidersSection.handleSave` / `handleDelete` → `"API key saved" / "API key removed"`
- `CompatProviderForm.handleSave` → `"Provider saved"`
- `IntegrationsSection.saveRow` → `"GitHub check settings saved"`
- `MembersSection` role update → `"Member role updated"`
- `AccountSection.handleDelete` → toast immediately before redirect/logout.
### Step 5 — Inline banners: keep or remove?
`WorkspaceMfaPolicyPanel`, `WorkspaceSpendCapsPanel`, `ProviderCard`, `IntegrationsSection` (GitHub install flow) use `setStatus({ type, text })`.
- **Option A (recommended):** keep inline banners *and* add toast. Banner survives the 3s fade; toast confirms the action.
- **Option B:** remove `setStatus`, rely on toast only.
Pick one and apply consistently in this PR.
### Step 6 — Audit pass
```bash
grep -rn "await api\.\(update\|create\|delete\|save\|patch\|put\|post\)" \
    frontend/src --include="*.jsx"
```
Every result must have a sibling toast call, OR an explicit comment justifying silent success (e.g. "redirect makes toast pointless").
### Step 7 — Tests
- Snapshot test for `<ToastProvider>` rendering.
- Per-section unit tests: mock the relevant `api.*` call, click Save, assert toast renders with the expected message.
- Regression test for `Automation.jsx`: assert `onPanelToast` does NOT call `addNotification` for save-success events.
### Step 8 — QA.md
Add a new section **"Toast feedback on save/update/delete (UX-001)"**:
- [ ] Settings → Agent Roles → Save role → toast `"Agent role saved"`.
- [ ] Settings → Agent Roles → Edit + Update role → toast `"Agent role updated"`.
- [ ] Settings → Agent Roles → Delete role → toast `"Agent role deleted"`.
- [ ] Settings → AI Providers → Save key → toast `"API key saved"`.
- [ ] Settings → AI Providers → Delete key → toast `"API key removed"`.
- [ ] Settings → AI Providers → OpenAI-compat slot save → toast `"Provider saved"`.
- [ ] Settings → Provider Routes → Save route → toast `"Provider route saved"`.
- [ ] Settings → Provider Routes → Delete route → toast `"Provider route deleted"`.
- [ ] Settings → Provider Routes → Spend caps → toast `"Spend caps updated"`.
- [ ] Settings → Integrations → Save GitHub check settings → toast.
- [ ] Settings → Members → Change role → toast `"Member role updated"`.
- [ ] Settings → Security → MFA policy → toast `"Workspace MFA policy updated"`.
- [ ] Settings → Account → Delete account → toast immediately before redirect/logout.
- [ ] New Project → Create → toast `"Project created"` before navigation.
- [ ] New Project → Edit → toast `"Project updated"` before navigation.
- [ ] Automation → Auto-Approval → set 0.8 → confirm modal → toast `"Auto-approval threshold set to 0.8"` **(currently broken — root cause `Automation.jsx:68-73`)**.
- [ ] Automation → Auto-Approval → clear input → toast `"Auto-approval disabled"`.
- [ ] Automation → Coverage settings → Save → toast `"Coverage settings saved"` **(currently broken)**.
- [ ] Automation → Quality Gates → Save → toast `"Quality gates saved"` **(currently broken)**.
- [ ] Automation → Quality Gates → Clear → toast `"Quality gates cleared"` **(currently broken)**.
- [ ] Automation → Web Vitals Budgets → Save → toast `"Web Vitals budgets saved"` **(currently broken)**.
- [ ] Project → Environments → Add/Edit/Delete → toast (already works — regression check).
- [ ] Project Detail → Approve/Reject/Restore test → toast (already works — regression check).
- [ ] Test Detail → Save Changes → toast `"Test updated"`.
- [ ] All error paths show a red toast with the API error message.
### Step 9 — docs/changelog.md
Under `## [Unreleased]` § Fixed:
> **UX-001 — Restore success/failure toast feedback across save/update/delete actions.** The `/automation` page was wiring panel toast callbacks to `addNotification()` (the notification bell at `frontend/src/pages/Automation.jsx:68-73`), so users saving Auto-Approval threshold, Quality Gates, Web Vitals, or Coverage settings saw no visible confirmation. The new project create/edit form (`frontend/src/pages/NewProject.jsx:144-186`) silently navigated away on success without any toast. The decomposed `frontend/src/features/settings/sections/*` surface (Agent Roles, AI Providers, Provider Routes, Integrations, Members) silently completed every save/update/delete. Introduced a global `ToastContext` at `frontend/src/context/ToastContext.jsx` and migrated every `api.update*` / `api.create*` / `api.delete*` callsite to emit a visible toast on both success and error. Inline `setStatus({type,text})` banners on the durable panels (`WorkspaceMfaPolicyPanel`, `WorkspaceSpendCapsPanel`, `ProviderCard`) are kept in addition to the toast — banner survives the 3s fade for long forms; toast confirms the action immediately.
---
## Out-of-scope (call out in PR description)
- Replacing the in-house toast with `react-hot-toast` or any third-party library — keep the existing visual from `ProjectDetail.jsx:130-133`.
- Migrating the notification bell — it serves a different purpose (durable, async, cross-page events like run-complete, scheduled-trigger fired) and should stay.
- Backend changes — this is purely a frontend UX fix.
- Visual redesign of the toast component — scope is wiring, not styling.
---
## PR checklist (UX-001)
- [ ] PR title: `fix(ui): UX-001 — restore success/failure toast feedback across save/update/delete actions`
- [ ] Branch off `develop`, not `main`.
- [ ] `cd frontend && npm run build && npm test` passes locally.
- [ ] `cd backend && npm test` passes locally (no backend changes, but mandatory per REVIEW.md).
- [ ] New `frontend/src/context/ToastContext.jsx` with unit test.
- [ ] All 14 files in the 🔴 + 🟡 lists migrated.
- [ ] Manual smoke test against the 25-item QA.md checklist above.
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Fixed.
- [ ] `QA.md` § "Toast feedback on save/update/delete (UX-001)" landed.
- [ ] No accessibility regression — toast has `role="status"` + `aria-live="polite"` (already true if reusing `ProjectDetail.jsx:130-133` visual).
- [ ] No secrets, API keys, or credentials in the diff.
---
## Risk & rollback
- **Blast radius:** frontend-only, no API contract changes, no schema migrations.
- **Rollback:** revert the single commit. The notification bell continues to work (it's the *current* — broken — behavior on Automation), so reverting takes the app back to the silent-but-functional state.
- **Mitigation:** ship behind no feature flag — UX regressions are obvious in QA and the change is purely additive (new toast on top of existing behavior).
