/**
 * @module utils/objectStorage
 * @description Storage adapter for local artifacts and S3-compatible object stores.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

// MNT-006: this module is statically imported by appSetup.js. In ESM, static
// imports are evaluated before the importer's module body runs, so reading
// process.env at module-eval time would fire *before* appSetup.js's
// dotenv.config() call — silently leaving STORAGE_BACKEND="local" even when
// .env declares STORAGE_BACKEND=s3. Mirror appSetup.js's pattern: call
// dotenv.config() here too. dotenv does not overwrite already-set env vars,
// so calling it from multiple modules is safe.
dotenv.config();

const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || "local").toLowerCase();
const S3_BUCKET = process.env.S3_BUCKET || "";
const S3_REGION = process.env.S3_REGION || "us-east-1";
const S3_ENDPOINT = process.env.S3_ENDPOINT || "";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "";
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || "";

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hmac(key, data, enc) {
  return crypto.createHmac("sha256", key).update(data).digest(enc);
}

function s3Host() {
  if (S3_ENDPOINT) return new URL(S3_ENDPOINT).host;
  return `${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
}

function s3BaseUrl() {
  if (S3_ENDPOINT) return `${S3_ENDPOINT.replace(/\/$/, "")}/${S3_BUCKET}`;
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
}

/**
 * RFC 3986 encoder per AWS SigV4 spec. `encodeURIComponent` is RFC 3986
 * compliant except it does not encode `!*'()` — AWS requires those encoded
 * (except in the path, where `/` is preserved by joining segments).
 */
function rfc3986(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, c =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function encodeS3Key(key) {
  // Encode each path segment individually so `/` separators are preserved
  // but `#`, `?`, `&`, `=`, `@`, spaces, etc. inside a segment are escaped.
  return key.split("/").map(rfc3986).join("/");
}

function canonicalQueryString(params) {
  // AWS V4 requires sorted keys and RFC 3986 encoding of both keys & values.
  // URLSearchParams uses form-encoding (`+` for space) which breaks signing
  // for any value containing a space or reserved char. Build it manually.
  return [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");
}

function s3CanonicalUri(key) {
  const encoded = encodeS3Key(key);
  if (S3_ENDPOINT) return `/${rfc3986(S3_BUCKET)}/${encoded}`;
  return `/${encoded}`;
}

function s3SignKey(dateStamp) {
  const kDate = hmac(`AWS4${S3_SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = hmac(kDate, S3_REGION);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function toObjectKey(artifactPath) {
  return artifactPath.replace(/^\/artifacts\//, "");
}

export async function writeArtifactBuffer({ artifactPath, absolutePath, buffer, contentType = "application/octet-stream" }) {
  // Always persist to local disk so downstream code paths that still read from
  // the filesystem (e.g. baseline acceptance, video/trace post-processing)
  // continue to work even when STORAGE_BACKEND=s3. In s3 mode we additionally
  // upload the buffer to the configured object store below.
  ensureDir(absolutePath);
  fs.writeFileSync(absolutePath, buffer);
  if (STORAGE_BACKEND !== "s3") {
    return;
  }
  const key = toObjectKey(artifactPath);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = s3Host();
  const payloadHash = sha256Hex(buffer);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    s3CanonicalUri(key),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmac(s3SignKey(dateStamp), stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(`${s3BaseUrl()}/${encodeS3Key(key)}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": payloadHash,
      Authorization: authorization,
    },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`S3 upload failed (${res.status}) for ${artifactPath}`);
  }
}

export function signS3ArtifactUrl(artifactPath, ttlMs) {
  if (STORAGE_BACKEND !== "s3") return artifactPath;
  const key = toObjectKey(artifactPath);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const expiresSec = Math.max(1, Math.floor(ttlMs / 1000));
  const host = s3Host();
  const scope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${S3_ACCESS_KEY_ID}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": "host",
  });
  const canonicalRequest = [
    "GET",
    s3CanonicalUri(key),
    canonicalQueryString(params),
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmac(s3SignKey(dateStamp), stringToSign, "hex");
  params.set("X-Amz-Signature", signature);
  return `${s3BaseUrl()}/${encodeS3Key(key)}?${canonicalQueryString(params)}`;
}

export function isS3Storage() {
  return STORAGE_BACKEND === "s3";
}

/**
 * Origin (scheme + host, no path) that pre-signed S3 artifact URLs are served
 * from. Used by the CSP middleware in `appSetup.js` to allow the browser to
 * load `<img>` / `<video>` artifacts from the configured object store.
 *
 * Returns `null` when S3 is not configured or the endpoint cannot be parsed —
 * callers should treat that as "no S3 origin to allow" and fall back to
 * same-origin-only CSP.
 *
 * @returns {string|null}
 */
export function s3PublicOrigin() {
  if (STORAGE_BACKEND !== "s3") return null;
  try {
    if (S3_ENDPOINT) return new URL(S3_ENDPOINT).origin;
    if (!S3_BUCKET) return null;
    return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
  } catch {
    return null;
  }
}

/**
 * Read an artifact buffer. In local mode, reads from `absolutePath`. In s3
 * mode, fetches the object via a short-lived pre-signed GET URL and falls
 * back to the local copy (dual-write safety net) on failure.
 *
 * @param {Object} args
 * @param {string} args.artifactPath - URL path, e.g. `/artifacts/baselines/…`
 * @param {string} args.absolutePath - Local filesystem fallback path.
 * @returns {Promise<Buffer|null>}
 */
export async function readArtifactBuffer({ artifactPath, absolutePath }) {
  if (STORAGE_BACKEND !== "s3") {
    try { return fs.readFileSync(absolutePath); } catch { return null; }
  }
  try {
    const url = signS3ArtifactUrl(artifactPath, 60 * 1000);
    const res = await fetch(url, { method: "GET" });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  } catch { /* fall through to local */ }
  try { return fs.readFileSync(absolutePath); } catch { return null; }
}
