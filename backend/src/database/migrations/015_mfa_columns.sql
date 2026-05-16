-- SEC-004: MFA columns on users table.
ALTER TABLE users ADD COLUMN mfaSecret TEXT;
ALTER TABLE users ADD COLUMN mfaEnabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfaRecoveryCodes TEXT;
