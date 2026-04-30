/**
 * @module utils/objectStorage
 * @description Storage adapter for local artifacts and S3-compatible object stores.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

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

function s3CanonicalUri(key) {
  const encoded = encodeURI(key).replace(/%2F/g, "/");
  if (S3_ENDPOINT) return `/${S3_BUCKET}/${encoded}`;
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
  const res = await fetch(`${s3BaseUrl()}/${key}`, {
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
    params.toString(),
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmac(s3SignKey(dateStamp), stringToSign, "hex");
  params.set("X-Amz-Signature", signature);
  return `${s3BaseUrl()}/${key}?${params.toString()}`;
}

export function isS3Storage() {
  return STORAGE_BACKEND === "s3";
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
