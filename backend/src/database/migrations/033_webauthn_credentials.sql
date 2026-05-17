-- SEC-004: WebAuthn / passkey credentials.
--
-- One user → many credentials (a user can register multiple authenticators:
-- phone passkey, hardware key, laptop biometric, etc.). Credentials are
-- looked up by `id` (the WebAuthn credential ID, base64url-encoded) at
-- assertion time and scoped by `userId` for delete to prevent cross-user
-- credential removal.
--
-- `publicKey` stores the COSE-encoded public key in base64. This is public
-- by definition (the device keeps the private key in its secure enclave)
-- so it is NOT encrypted at rest — unlike TOTP secrets which must be.
--
-- `counter` tracks the signature counter for clone detection. A successful
-- authentication that returns a counter <= the stored counter indicates a
-- cloned credential and the auth flow MUST reject the assertion.
--
-- `transports` is a JSON array hint to the browser at authentication time
-- so the user is prompted with the right factor first
-- (e.g. ["internal"] = platform biometric, ["usb","nfc"] = hardware key).
--
-- Cascade-deletes on user deletion so SEC-003 account-erasure removes
-- credentials too.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  publicKey TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  deviceName TEXT,
  createdAt TEXT NOT NULL,
  lastUsedAt TEXT,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(userId);
