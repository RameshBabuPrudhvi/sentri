/**
 * @module utils/mfaEnforcement
 * @description Per-workspace MFA enforcement helpers (SEC-004).
 *
 * Workspaces with `mfaRequired = 1` (migration 028) block login for any
 * member whose user account has `mfaEnabled = 0` once they are past the
 * grace window. The grace window starts at the later of:
 *   - the workspace's `mfaPolicyUpdatedAt` (when the policy flipped on)
 *   - the membership's `joinedAt` (so a new hire still gets a fair window
 *     even if the policy has been in place for months)
 * and lasts `mfaGracePeriodDays` calendar days.
 *
 * A user who belongs to multiple workspaces is enforced by the strictest
 * one: if ANY workspace they belong to is past-grace and requires MFA,
 * login is blocked.
 *
 * ### Exports
 * - {@link evaluateMfaEnforcement} — Decide enforce / grace / allow for a user.
 */
import * as workspaceRepo from "../database/repositories/workspaceRepo.js";
import * as webauthnRepo from "../database/repositories/webauthnRepo.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @typedef {Object} MfaEnforcementDecision
 * @property {"allow"|"grace"|"block"} state - Final decision.
 * @property {string} [workspaceId] - Workspace that produced the decision (block / grace only).
 * @property {string} [workspaceName] - Display name for the same workspace.
 * @property {number} [gracePeriodDaysRemaining] - Ceil-rounded days left when state="grace".
 * @property {string} [graceEndsAt] - ISO timestamp when the user becomes blocked.
 */

/**
 * Evaluate whether MFA enforcement blocks, grace-warns, or allows a login
 * for a user. Pure function — no side effects, safe to call from any auth
 * surface (`/login`, `/refresh`, OAuth callbacks).
 *
 * Users are "MFA-enabled" if EITHER `mfaEnabled === 1` (TOTP) OR they have at
 * least one registered WebAuthn credential. Either factor satisfies the
 * workspace requirement — otherwise an OAuth-only user with a passkey but no
 * TOTP would be falsely blocked at OAuth callback time.
 *
 * @param {Object} user - User row (must include `id`, `mfaEnabled`, `createdAt`).
 * @returns {MfaEnforcementDecision}
 */
export function evaluateMfaEnforcement(user) {
  if (!user) return { state: "allow" };
  if (user.mfaEnabled === 1) return { state: "allow" };
  // SEC-004 — a registered passkey is just as strong a second factor as TOTP,
  // so it satisfies workspace enforcement on its own. Checked second because
  // it requires a DB round-trip; TOTP enabled is the cheap fast-path above.
  if (webauthnRepo.countByUser(user.id) > 0) return { state: "allow" };

  const memberships = workspaceRepo.getByUserId(user.id);
  if (!memberships || memberships.length === 0) return { state: "allow" };

  const now = Date.now();
  /** @type {MfaEnforcementDecision} */
  let strictest = { state: "allow" };

  for (const ws of memberships) {
    if (ws.mfaRequired !== 1) continue;

    const graceDays = Math.max(0, Number.isFinite(ws.mfaGracePeriodDays) ? ws.mfaGracePeriodDays : 7);
    // Grace clock starts at MAX(policy-flipped, user-joined, account-created).
    // `joinedAt` is on the membership row (see workspaceRepo.getByUserId join).
    const policyAt = ws.mfaPolicyUpdatedAt ? Date.parse(ws.mfaPolicyUpdatedAt) : null;
    const joinedAt = ws.joinedAt ? Date.parse(ws.joinedAt) : null;
    const accountAt = user.createdAt ? Date.parse(user.createdAt) : null;
    const candidates = [policyAt, joinedAt, accountAt].filter((v) => Number.isFinite(v));
    const graceStart = candidates.length > 0 ? Math.max(...candidates) : now;
    const graceEnd = graceStart + (graceDays * MS_PER_DAY);

    if (now >= graceEnd) {
      // Past grace — strictest possible outcome, short-circuit.
      return {
        state: "block",
        workspaceId: ws.id,
        workspaceName: ws.name,
        graceEndsAt: new Date(graceEnd).toISOString(),
      };
    }

    // Within grace — record as candidate; keep scanning in case another
    // workspace is already past grace (block wins over grace).
    const remaining = Math.ceil((graceEnd - now) / MS_PER_DAY);
    if (strictest.state === "allow" || (strictest.gracePeriodDaysRemaining ?? Infinity) > remaining) {
      strictest = {
        state: "grace",
        workspaceId: ws.id,
        workspaceName: ws.name,
        gracePeriodDaysRemaining: remaining,
        graceEndsAt: new Date(graceEnd).toISOString(),
      };
    }
  }

  return strictest;
}
