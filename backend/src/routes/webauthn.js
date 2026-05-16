/**
 * @module routes/webauthn
 * @description WebAuthn / passkey registration + authentication (SEC-004).
 *
 * Implements FIDO2 / WebAuthn Level 2 via `@simplewebauthn/server`. Users
 * can register multiple credentials (phone passkey, hardware key, laptop
 * biometric) and use any of them as a second factor — or as the primary
 * factor when no TOTP secret is set.
 *
 * ### Endpoints (all under `/api/v1/auth/webauthn`)
 * | Method | Path                       | Auth          | Purpose                              |
 * |--------|----------------------------|---------------|--------------------------------------|
 * | POST   | `/register/options`        | requireAuth   | Generate registration challenge.     |
 * | POST   | `/register/verify`         | requireAuth   | Verify attestation, store credential.|
 * | POST   | `/authenticate/options`    | public (login)| Generate assertion challenge.        |
 * | POST   | `/authenticate/verify`     | public (login)| Verify assertion, issue auth cookie. |
 * | GET    | `/credentials`             | requireAuth   | List user's credentials.             |
 * | DELETE | `/credentials/:id`         | requireAuth   | Remove credential (password confirm).|
 *
 * Pre-auth endpoints (`authenticate/*`) are authenticated by the
 * `pendingToken` issued by `/auth/login` — same pattern as `/mfa/verify`.
 *
 * ### Configuration
 * | Env var               | Default                | Description                       |
 * |-----------------------|------------------------|-----------------------------------|
 * | `WEBAUTHN_RP_ID`      | `req.hostname`         | Relying Party ID (the domain).    |
 * | `WEBAUTHN_RP_NAME`    | `"Sentri"`             | Display name in passkey prompts.  |
 * | `WEBAUTHN_ORIGIN`     | derived from request   | Expected origin (CSV for multi).  |
 *
 * ### Optional dependency
 * `@simplewebauthn/server` is in `optionalDependencies` so a self-hoster who
 * does not need passkeys can omit the install via `npm install --omit=optional`.
 * When the module is unavailable every endpoint returns 503 instead of
 * crashing the server.
 */

import express from "express";
import crypto from "crypto";
import * as userRepo from "../database/repositories/userRepo.js";
import * as webauthnRepo from "../database/repositories/webauthnRepo.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { logActivity } from "../utils/activityLogger.js";
import { evaluateMfaEnforcement } from "../utils/mfaEnforcement.js";
import { buildJwtPayload, buildUserResponse } from "../utils/authWorkspace.js";
import { signJwt, getJwtSecret } from "../middleware/authenticate.js";
import {
  setAuthCookie, JWT_TTL_SEC, requireAuth,
  _internalConsumePendingMfaLogin,
} from "./auth.js";

// ─── Lazy-loaded SimpleWebAuthn server module ─────────────────────────────────
// `@simplewebauthn/server` is in optionalDependencies (matches pg / bullmq
// pattern). We try to load it once at module init and fall back to a 503-only
// stub when missing so the server still boots without it.
let _simplewebauthn = null;
try {
  _simplewebauthn = await import("@simplewebauthn/server");
} catch (err) {
  console.warn(formatLogLine("warn", null,
    `[webauthn] @simplewebauthn/server not installed — passkey routes will return 503. ` +
    `Run \`npm install @simplewebauthn/server\` to enable. (${err.message})`));
}

/**
 * Reject the request when the WebAuthn dependency is missing.
 * @param {Object} res
 * @returns {boolean} `true` if the dep is missing and a 503 was sent.
 * @private
 */
function bailIfUnavailable(res) {
  if (_simplewebauthn) return false;
  res.status(503).json({
    error: "Passkey support is not configured on this server.",
    code: "WEBAUTHN_UNAVAILABLE",
  });
  return true;
}

// ─── Pending-challenge store (5-min TTL, periodic sweep) ─────────────────────
// Keyed by an opaque base64url token. Stores the challenge bytes and the
// associated user (registration) or pending-login (authentication). Same
// shape as auth.js / mfaPendingLogins so multi-replica deployments will
// migrate both to Redis under SEC-004c.
const challenges = new Map();
const CHALLENGE_TTL_MS = parseInt(process.env.WEBAUTHN_CHALLENGE_TTL_MS ?? "", 10) || 5 * 60 * 1000;

const _purge = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) {
    if (v.expiresAt < now) challenges.delete(k);
  }
}, 5 * 60 * 1000);
_purge.unref();

/**
 * Resolve the WebAuthn Relying Party config from request + env. The RP ID
 * is the bare domain (no scheme, no port) the credentials are scoped to —
 * if the user later visits a sibling subdomain the credential still works
 * provided the RP ID stays the same.
 *
 * @param {Object} req
 * @returns {{ rpID: string, rpName: string, origin: string|string[] }}
 * @private
 */
function rpConfig(req) {
  const rpID = process.env.WEBAUTHN_RP_ID || req.hostname || "localhost";
  const rpName = process.env.WEBAUTHN_RP_NAME || "Sentri";
  const originEnv = process.env.WEBAUTHN_ORIGIN;
  let origin;
  if (originEnv) {
    origin = originEnv.includes(",") ? originEnv.split(",").map((o) => o.trim()) : originEnv;
  } else {
    // Derive from request — protocol + host. Works for localhost dev and
    // single-origin production. Multi-origin deployments must set
    // WEBAUTHN_ORIGIN explicitly.
    origin = `${req.protocol}://${req.get("host")}`;
  }
  return { rpID, rpName, origin };
}

/**
 * Issue a single-use challenge token. Caller stores any context (userId,
 * pendingToken) in the entry so the verify step can pick up where options
 * left off.
 * @param {Object} entry
 * @returns {string} Opaque base64url challenge token.
 * @private
 */
function storeChallenge(entry) {
  const token = crypto.randomBytes(24).toString("base64url");
  challenges.set(token, { ...entry, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return token;
}

/**
 * Atomically consume a challenge token. Returns the entry on success and
 * deletes it (single-use). Returns null when missing or expired.
 * @param {string} token
 * @returns {Object|null}
 * @private
 */
function consumeChallenge(token) {
  const entry = challenges.get(token);
  if (!entry) return null;
  challenges.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

const router = express.Router();

// ─── Registration (requireAuth) ──────────────────────────────────────────────

/**
 * Start passkey registration. Returns the registration options the browser
 * passes to `navigator.credentials.create()`. The associated challenge is
 * stored server-side for 5 minutes; the client must call `/register/verify`
 * within that window.
 *
 * @route POST /api/v1/auth/webauthn/register/options
 */
router.post("/register/options", requireAuth, async (req, res) => {
  if (bailIfUnavailable(res)) return;
  try {
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });
    const { rpID, rpName } = rpConfig(req);

    const existing = webauthnRepo.listByUser(user.id);
    const options = await _simplewebauthn.generateRegistrationOptions({
      rpName,
      rpID,
      // User ID per WebAuthn spec is opaque bytes. Browsers refuse to
      // overwrite credentials with the same (rpID, userId) so we must
      // pass a stable per-user identifier — the database PK.
      userID: Buffer.from(user.id, "utf8"),
      userName: user.email,
      userDisplayName: user.name || user.email,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        type: "public-key",
        transports: c.transports,
      })),
      authenticatorSelection: {
        userVerification: "preferred",
        residentKey: "preferred",
      },
    });

    const challengeToken = storeChallenge({
      kind: "register",
      userId: user.id,
      challenge: options.challenge,
    });

    return res.json({ options, challengeToken });
  } catch (err) {
    console.error(formatLogLine("error", null, `[webauthn/register/options] ${err.message}`));
    return res.status(500).json({ error: "Failed to start passkey registration." });
  }
});

/**
 * Verify a passkey registration attestation. On success persists the
 * credential and returns the stored row (minus the public key).
 *
 * @route POST /api/v1/auth/webauthn/register/verify
 * @param {Object} req.body
 * @param {string} req.body.challengeToken - From `/register/options`.
 * @param {Object} req.body.attestation    - The browser's PublicKeyCredential.
 * @param {string} [req.body.deviceName]   - User-supplied label.
 */
router.post("/register/verify", requireAuth, async (req, res) => {
  if (bailIfUnavailable(res)) return;
  try {
    const entry = consumeChallenge(String(req.body?.challengeToken || ""));
    if (!entry || entry.kind !== "register" || entry.userId !== req.authUser.sub) {
      return res.status(400).json({ error: "Registration challenge expired or invalid." });
    }
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });

    const { rpID, origin } = rpConfig(req);
    let verification;
    try {
      verification = await _simplewebauthn.verifyRegistrationResponse({
        response: req.body?.attestation,
        expectedChallenge: entry.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (verifyErr) {
      return res.status(400).json({ error: `Attestation failed: ${verifyErr.message}` });
    }

    if (!verification?.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: "Attestation did not verify." });
    }

    // SimpleWebAuthn v11 returns { credential: { id, publicKey, counter, transports } }.
    // Older v10 callers used { credentialID, credentialPublicKey, counter }. Handle
    // both shapes so a self-hoster pinning an older version doesn't break.
    const info = verification.registrationInfo;
    const credIdRaw = info.credential?.id ?? info.credentialID;
    const pubKeyRaw = info.credential?.publicKey ?? info.credentialPublicKey;
    const counter = info.credential?.counter ?? info.counter ?? 0;
    if (!credIdRaw || !pubKeyRaw) {
      return res.status(500).json({ error: "Verification returned an unexpected shape." });
    }
    const credentialId = typeof credIdRaw === "string" ? credIdRaw : Buffer.from(credIdRaw).toString("base64url");
    const publicKey = Buffer.from(pubKeyRaw).toString("base64");
    const transports = Array.isArray(req.body?.attestation?.response?.transports)
      ? req.body.attestation.response.transports
      : [];
    const deviceName = typeof req.body?.deviceName === "string"
      ? req.body.deviceName.trim().slice(0, 80)
      : null;

    const stored = webauthnRepo.create({
      id: credentialId,
      userId: user.id,
      publicKey,
      counter,
      transports,
      deviceName,
    });

    logActivity({
      type: "auth.mfa.webauthn_registered",
      detail: "Registered a WebAuthn credential.",
      userId: user.id, userName: user.name || user.email,
      workspaceId: req.authUser.workspaceId,
      meta: { credentialId, deviceName, transports },
    });

    return res.json({
      ok: true,
      credential: {
        id: stored.id,
        deviceName: stored.deviceName,
        transports: stored.transports,
        createdAt: stored.createdAt,
        lastUsedAt: stored.lastUsedAt,
      },
    });
  } catch (err) {
    console.error(formatLogLine("error", null, `[webauthn/register/verify] ${err.message}`));
    return res.status(500).json({ error: "Failed to verify passkey registration." });
  }
});

// ─── Authentication (pre-auth, uses pendingToken from /login) ────────────────

/**
 * Start passkey authentication during the login flow. Caller passes the
 * `pendingToken` returned by `POST /auth/login` so the server knows which
 * user's credentials to allow.
 *
 * The `pendingToken` is NOT consumed here (it's still needed at the verify
 * step). The challenge response carries its own opaque token tying the
 * subsequent verify call to this request.
 *
 * @route POST /api/v1/auth/webauthn/authenticate/options
 * @param {Object} req.body
 * @param {string} req.body.pendingToken - From `/auth/login`.
 */
router.post("/authenticate/options", async (req, res) => {
  if (bailIfUnavailable(res)) return;
  try {
    const pendingToken = String(req.body?.pendingToken || "").slice(0, 200);
    if (!pendingToken) return res.status(400).json({ error: "pendingToken is required." });

    // Peek (do not consume) the pending-MFA login entry to find the user.
    // The actual consume happens at /authenticate/verify when we know the
    // assertion is valid, so a failed assertion does not waste the token.
    const peek = _internalConsumePendingMfaLogin(pendingToken, { peek: true });
    if (!peek) return res.status(401).json({ error: "MFA session expired. Sign in again." });

    const credentials = webauthnRepo.listByUser(peek.userId);
    if (credentials.length === 0) {
      return res.status(400).json({ error: "No passkeys registered for this account." });
    }

    const { rpID } = rpConfig(req);
    const options = await _simplewebauthn.generateAuthenticationOptions({
      rpID,
      allowCredentials: credentials.map((c) => ({
        id: c.id,
        type: "public-key",
        transports: c.transports,
      })),
      userVerification: "preferred",
    });

    const challengeToken = storeChallenge({
      kind: "authenticate",
      userId: peek.userId,
      pendingToken,
      challenge: options.challenge,
    });

    return res.json({ options, challengeToken });
  } catch (err) {
    console.error(formatLogLine("error", null, `[webauthn/authenticate/options] ${err.message}`));
    return res.status(500).json({ error: "Failed to start passkey authentication." });
  }
});

/**
 * Verify a passkey assertion. On success consumes the `pendingToken`,
 * issues the auth cookie with `amr: ["pwd","mfa"]`, and updates the
 * credential's signature counter.
 *
 * Clone detection: if the asserted counter is ≤ the stored counter the
 * credential may have been cloned — reject the assertion outright and
 * audit-log the event for admin review.
 *
 * @route POST /api/v1/auth/webauthn/authenticate/verify
 * @param {Object} req.body
 * @param {string} req.body.challengeToken
 * @param {Object} req.body.assertion - The browser's PublicKeyCredential.
 */
router.post("/authenticate/verify", async (req, res) => {
  if (bailIfUnavailable(res)) return;
  try {
    const entry = consumeChallenge(String(req.body?.challengeToken || ""));
    if (!entry || entry.kind !== "authenticate") {
      return res.status(400).json({ error: "Authentication challenge expired or invalid." });
    }

    const assertion = req.body?.assertion;
    const credentialId = assertion?.id;
    if (!credentialId) return res.status(400).json({ error: "Missing credential id." });

    const stored = webauthnRepo.getById(credentialId);
    if (!stored || stored.userId !== entry.userId) {
      logActivity({
        type: "auth.mfa.verify_failed",
        detail: "WebAuthn assertion for unknown credential.",
        userId: entry.userId,
        meta: { method: "webauthn", reason: "unknown_credential" },
      });
      return res.status(400).json({ error: "Unknown credential." });
    }

    const { rpID, origin } = rpConfig(req);
    let verification;
    try {
      verification = await _simplewebauthn.verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: entry.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
        // SimpleWebAuthn v11 takes `credential`; v10 takes `authenticator`.
        // We pass both shapes for forward-compat.
        credential: {
          id: stored.id,
          publicKey: Buffer.from(stored.publicKey, "base64"),
          counter: stored.counter,
          transports: stored.transports,
        },
        authenticator: {
          credentialID: stored.id,
          credentialPublicKey: Buffer.from(stored.publicKey, "base64"),
          counter: stored.counter,
          transports: stored.transports,
        },
      });
    } catch (verifyErr) {
      logActivity({
        type: "auth.mfa.verify_failed",
        detail: "WebAuthn assertion failed verification.",
        userId: entry.userId,
        meta: { method: "webauthn", reason: verifyErr.message },
      });
      return res.status(400).json({ error: `Assertion failed: ${verifyErr.message}` });
    }

    if (!verification?.verified || !verification.authenticationInfo) {
      return res.status(400).json({ error: "Assertion did not verify." });
    }

    // Clone detection: a successful assertion that returns a counter ≤
    // stored.counter means the credential has been cloned (the original
    // and the copy both incremented from different baselines). Reject
    // outright. Counter 0 from both sides is allowed (some authenticators
    // intentionally never increment — Apple platform passkeys, for example).
    const newCounter = verification.authenticationInfo.newCounter ?? 0;
    if (newCounter !== 0 && newCounter <= stored.counter) {
      logActivity({
        type: "auth.mfa.verify_failed",
        detail: "WebAuthn clone detected — counter rollback.",
        userId: entry.userId,
        meta: { method: "webauthn", reason: "clone_detected", oldCounter: stored.counter, newCounter },
      });
      return res.status(401).json({
        error: "Credential clone detected. Contact an administrator.",
        code: "WEBAUTHN_CLONE_DETECTED",
      });
    }

    // All checks passed — consume the pendingToken now, atomically.
    const pending = _internalConsumePendingMfaLogin(entry.pendingToken);
    if (!pending) return res.status(401).json({ error: "MFA session expired. Sign in again." });

    webauthnRepo.updateCounter(stored.id, newCounter);

    const user = userRepo.getById(pending.userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    logActivity({
      type: "auth.mfa.webauthn_verified",
      detail: "WebAuthn login verified.",
      userId: user.id, userName: user.name || user.email,
      meta: { credentialId: stored.id },
    });

    // SEC-004 §5c: MFA-asserted session — pwd was proved at /login, mfa
    // here. Same shape as the TOTP/recovery path in /mfa/verify.
    const payload = buildJwtPayload(user, undefined, { amr: ["pwd", "mfa"] });
    const jwt = signJwt(payload, getJwtSecret());
    const exp = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;
    setAuthCookie(res, jwt, exp);

    return res.json({ user: buildUserResponse(user) });
  } catch (err) {
    console.error(formatLogLine("error", null, `[webauthn/authenticate/verify] ${err.message}`));
    return res.status(500).json({ error: "Failed to verify passkey." });
  }
});

// ─── Credential management (requireAuth) ─────────────────────────────────────

/**
 * List the authenticated user's registered passkeys. Excludes the public key
 * (not needed client-side; reduces response size + accidental exposure).
 *
 * @route GET /api/v1/auth/webauthn/credentials
 */
router.get("/credentials", requireAuth, (req, res) => {
  try {
    const creds = webauthnRepo.listByUser(req.authUser.sub).map((c) => ({
      id: c.id,
      deviceName: c.deviceName,
      transports: c.transports,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    }));
    return res.json({ credentials: creds });
  } catch (err) {
    console.error(formatLogLine("error", null, `[webauthn/credentials] ${err.message}`));
    return res.status(500).json({ error: "Failed to list passkeys." });
  }
});

/**
 * Remove a passkey. Requires password confirmation (OAuth-only users
 * authenticate by session — see `verifyAccountPassword` semantics).
 *
 * Refuses to remove the last factor when a workspace policy requires MFA
 * and the user is past the grace window — preventing self-lockout.
 *
 * @route DELETE /api/v1/auth/webauthn/credentials/:id
 * @param {Object} req.body
 * @param {string} [req.body.password] - Required for non-OAuth-only users.
 */
router.delete("/credentials/:id", requireAuth, async (req, res) => {
  try {
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });

    // Lazy import to avoid pulling more of auth.js into the import graph
    // at module init. verifyAccountPassword skips OAuth-only users.
    const { _internalVerifyAccountPassword } = await import("./auth.js");
    if (typeof _internalVerifyAccountPassword === "function") {
      const valid = await _internalVerifyAccountPassword(user, req.body?.password);
      if (!valid) return res.status(403).json({ error: "Password confirmation failed." });
    }

    // Self-lockout guard: if this is the user's only factor and a workspace
    // they belong to requires MFA past grace, refuse the delete.
    const credCount = webauthnRepo.countByUser(user.id);
    const isLastFactor = credCount <= 1 && user.mfaEnabled !== 1;
    if (isLastFactor) {
      const enforcement = evaluateMfaEnforcement({ ...user, mfaEnabled: 0 });
      if (enforcement.state === "block") {
        return res.status(400).json({
          error: "Cannot remove your last second factor — your workspace requires MFA. Enroll a TOTP authenticator first.",
          code: "MFA_LAST_FACTOR_PROTECTED",
          workspaceId: enforcement.workspaceId,
        });
      }
    }

    const removed = webauthnRepo.deleteById(req.params.id, user.id);
    if (!removed) return res.status(404).json({ error: "Credential not found." });

    logActivity({
      type: "auth.mfa.webauthn_removed",
      detail: "Removed a WebAuthn credential.",
      userId: user.id, userName: user.name || user.email,
      workspaceId: req.authUser.workspaceId,
      meta: { credentialId: req.params.id },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error(formatLogLine("error", null, `[webauthn/credentials/:id] ${err.message}`));
    return res.status(500).json({ error: "Failed to remove passkey." });
  }
});

export default router;

/**
 * Test-only helper: count registered credentials for a user. Used by the
 * integration test suite (backend-tests lane) to assert the create / delete
 * paths persisted correctly without importing the repo directly.
 * @param {string} userId
 * @returns {number}
 */
export function _internalCountCredentials(userId) {
  return webauthnRepo.countByUser(userId);
}
