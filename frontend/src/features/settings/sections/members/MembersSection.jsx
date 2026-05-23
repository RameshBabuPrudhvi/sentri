import React, { useCallback, useState } from "react";
import {
  AlertCircle, Check, Crown, RefreshCw, Trash2, UserPlus, Users,
} from "lucide-react";
import { api } from "../../../../api.js";
import { useAuth } from "../../../../context/AuthContext.jsx";
import { useMembersQuery } from "../../../../hooks/queries/useSettingsQueries.js";
import SectionTitle from "../../shared/SectionTitle.jsx";

/**
 * Members section (ACL-002). Lists workspace members and lets admins invite
 * by email, change roles (admin / qa_lead / viewer), and remove members.
 *
 * Admin role is gated on the backend; the role-selector disables itself for
 * the current user so admins can't self-demote and lock the workspace out.
 * Extracted from Settings.jsx (GAP-002).
 */
const ROLE_OPTIONS = [
  { value: "admin",   label: "Admin",   desc: "Full access — manage members, settings, and all data" },
  { value: "qa_lead", label: "QA Lead", desc: "Create, edit, run, and delete tests and projects" },
  { value: "viewer",  label: "Viewer",  desc: "Read-only access to all data" },
];

export default function MembersSection() {
  const { user } = useAuth();
  const isAdmin = user?.workspaceRole === "admin";
  const [error, setError] = useState(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("viewer");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState(null);

  const membersQuery = useMembersQuery();
  const members = membersQuery.data || [];
  const loading = membersQuery.isLoading;
  const load = useCallback(() => membersQuery.refetch(), [membersQuery]);
  const displayError = error || membersQuery.error?.message || null;

  async function handleInvite(e) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteMsg(null);
    try {
      await api.inviteMember({ email: inviteEmail.trim().toLowerCase(), role: inviteRole });
      setInviteEmail("");
      setInviteRole("viewer");
      setInviteMsg({ type: "ok", text: "Member invited successfully." });
      await load();
    } catch (err) {
      setInviteMsg({ type: "err", text: err.message });
    } finally {
      setInviting(false);
    }
  }

  async function handleRoleChange(userId, role) {
    try {
      await api.updateMemberRole(userId, role);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRemove(userId, name) {
    if (!window.confirm(`Remove ${name} from this workspace?`)) return;
    try {
      await api.removeMember(userId);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return (
    <div className="text-sm text-muted members-loading">Loading members…</div>
  );

  return (
    <div className="flex-col gap-lg">
      <SectionTitle
        icon={<Users size={16} color="var(--accent)" />}
        title="Workspace Members"
        sub={`${members.length} member${members.length !== 1 ? "s" : ""}`}
      />

      {displayError && (
        <div className="card card-padded members-error">
          <AlertCircle size={15} /> {displayError}
        </div>
      )}

      {/* Invite form — admin-only. UX-AUDIT (May 2026): non-admins see the
          member roster (transparency, parity with GitHub / Linear / Vercel)
          but the invite UI is hidden. Backend `requireRole("admin")` on
          POST /workspace/members enforces this server-side too. */}
      {isAdmin && (
        <>
          <form onSubmit={handleInvite} className="card card-padded members-invite-form">
            <div className="members-invite__email">
              <label className="members-invite__label">
                <UserPlus size={12} className="members-invite__label-icon" />
                Invite by email
              </label>
              <input
                className="input members-invite__input"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@company.com"
                required
              />
            </div>
            <div className="members-invite__role">
              <label className="members-invite__label">Role</label>
              <select
                className="input members-invite__input"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary btn-sm members-invite__submit" type="submit" disabled={inviting || !inviteEmail.trim()}>
              {inviting ? <RefreshCw size={13} className="spin" /> : <UserPlus size={13} />}
              Invite
            </button>
          </form>
          {inviteMsg && (
            <div className={inviteMsg.type === "ok" ? "st-status-ok" : "st-status-err"}>
              {inviteMsg.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {inviteMsg.text}
            </div>
          )}
        </>
      )}

      {/* Member list */}
      <div className="flex-col gap-xs">
        {members.map((m) => {
          const isCurrentUser = m.userId === user?.id;
          return (
            <div key={m.userId} className="card members-row">
              <div className="members-row__avatar">
                {m.avatar
                  ? <img src={m.avatar} alt="" className="members-row__avatar-img" />
                  : (m.name || m.email || "?").charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 members-row__body">
                <div className="members-row__name-line">
                  <span className="font-semi text-sm members-row__name">
                    {m.name || m.email}
                  </span>
                  {isCurrentUser && (
                    <span className="badge members-row__you-badge">You</span>
                  )}
                  {m.role === "admin" && (
                    <Crown size={12} color="var(--amber)" />
                  )}
                </div>
                <div className="text-xs text-muted members-row__email">
                  {m.email}
                </div>
              </div>
              {isAdmin ? (
                <>
                  <select
                    className="input members-row__role-select"
                    value={m.role}
                    onChange={(e) => handleRoleChange(m.userId, e.target.value)}
                    disabled={isCurrentUser}
                    title={isCurrentUser ? "You cannot change your own role" : `Change role for ${m.name || m.email}`}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  <button
                    className="btn btn-ghost btn-xs members-row__remove-btn"
                    onClick={() => handleRemove(m.userId, m.name || m.email)}
                    disabled={isCurrentUser}
                    title={isCurrentUser ? "You cannot remove yourself" : `Remove ${m.name || m.email}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              ) : (
                /* Non-admin view: static role label, no role-change dropdown,
                   no remove button. Mirrors GitHub / Linear / Vercel where
                   viewers see who's in the workspace + each person's role
                   but cannot mutate. */
                <span className="badge badge-gray members-row__role-static">
                  {ROLE_OPTIONS.find((r) => r.value === m.role)?.label || m.role}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Role legend */}
      <div className="card card-padded members-legend-card">
        <div className="font-semi text-xs members-legend__title">Role permissions</div>
        <div className="flex-col gap-xs">
          {ROLE_OPTIONS.map((r) => (
            <div key={r.value} className="members-legend__row">
              <span className="text-sm font-semi members-legend__label">{r.label}</span>
              <span className="text-xs text-muted">{r.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
