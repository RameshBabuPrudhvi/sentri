/**
 * @module utils/ssrfGuard
 * @description Shared SSRF protection utilities.
 *
 * Extracted from `routes/trigger.js` so the same two-layer defence can be
 * reused wherever the server makes outbound HTTP requests to user-configured
 * URLs (notification webhooks, callback URLs, etc.).
 *
 * ### Exports
 * - {@link validateUrl}  — Synchronous string checks + async DNS resolution.
 * - {@link safeFetch}    — Fetch with DNS re-resolution and redirect blocking.
 * - {@link isPrivateIp}  — Check whether an IP is in a private/reserved range.
 */

import { URL } from "url";
import dns from "node:dns";

// ─── Private IP detection ─────────────────────────────────────────────────────

/** @type {Array<Array<number>>} [baseIp, mask, bits] for IPv4 */
const PRIVATE_IPV4_RANGES = [
  // 10.0.0.0/8
  [0x0A000000, 0xFF000000, 8],
  // 172.16.0.0/12
  [0xAC100000, 0xFFF00000, 12],
  // 192.168.0.0/16
  [0xC0A80000, 0xFFFF0000, 16],
  // 127.0.0.0/8 (loopback)
  [0x7F000000, 0xFF000000, 8],
  // 169.254.0.0/16 (link-local / cloud metadata)
  [0xA9FE0000, 0xFFFF0000, 16],
  // 0.0.0.0/8
  [0x00000000, 0xFF000000, 8],
];

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Check whether an IP address is in a private or reserved range.
 *
 * @param {string} ip - IPv4 or IPv6 address string.
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  // IPv6 loopback
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;

  // Only check IPv6 prefix ranges when the input is actually an IPv6 address
  // (contains a colon).  Without this guard, hostnames like "fdic.gov",
  // "fcbarcelona.com", or "ffmpeg.org" would be falsely rejected because
  // their first characters match IPv6 private-range prefixes.
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    // fc00::/7 — unique local addresses (includes fd00::/8)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // fe80::/10 — link-local
    if (lower.startsWith("fe80")) return true;
    // ff00::/8 — multicast
    if (lower.startsWith("ff")) return true;
    // :: — unspecified address
    if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return true;
  }

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  const v4match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const v4 = v4match ? v4match[1] : ip;
  const num = ipv4ToInt(v4);
  if (num === null) return false; // not an IP address — hostname validation is handled by the caller
  for (const [base, mask] of PRIVATE_IPV4_RANGES) {
    if (((num & mask) >>> 0) === base) return true;
  }
  return false;
}

// ─── URL validation ───────────────────────────────────────────────────────────

/**
 * Validate a URL for SSRF safety.
 *
 * Performs synchronous string checks (protocol, known private hostnames,
 * literal private IPs) and then resolves the hostname via DNS to catch
 * domains that point to private/reserved addresses.
 *
 * @param {string} raw - The URL to validate.
 * @returns {Promise<string|null>} null if valid, or an error message string.
 */
export async function validateUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return "URL is not valid."; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "URL must use http or https.";
  }
  // Block obvious private hostnames
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return "URL must not target a private/internal host.";
  }
  if (isPrivateIp(host)) {
    return "URL must not target a private or reserved IP address.";
  }

  // Resolve DNS to catch domains pointing to private IPs.
  if (ipv4ToInt(host) === null && !host.includes(":")) {
    try {
      const [v4addrs, v6addrs] = await Promise.all([
        dns.promises.resolve4(host).catch(() => []),
        dns.promises.resolve6(host).catch(() => []),
      ]);
      const allAddrs = [...v4addrs, ...v6addrs];
      if (allAddrs.length === 0) {
        return "URL hostname could not be resolved.";
      }
      for (const addr of allAddrs) {
        if (isPrivateIp(addr)) {
          return "URL resolves to a private or reserved IP address.";
        }
      }
    } catch {
      return "URL hostname could not be resolved.";
    }
  }

  return null; // valid
}

// ─── Safe fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch a URL with SSRF protections applied at request time.
 *
 * - Re-resolves DNS to mitigate DNS rebinding attacks.
 * - Blocks redirects (`redirect: "error"`) to prevent open-redirect SSRF bypass.
 *
 * @param {string} url     - The URL to fetch.
 * @param {Object} options - Standard fetch options (method, headers, body, signal, etc.).
 * @returns {Promise<Response>}
 * @throws {Error} If DNS re-resolution detects a private IP or the fetch fails.
 */
export async function safeFetch(url, options = {}) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (ipv4ToInt(host) === null && !host.includes(":")) {
    try {
      const [v4addrs, v6addrs] = await Promise.all([
        dns.promises.resolve4(host).catch(() => []),
        dns.promises.resolve6(host).catch(() => []),
      ]);
      const allAddrs = [...v4addrs, ...v6addrs];
      if (allAddrs.length === 0) {
        throw new Error("Hostname no longer resolves — aborting fetch.");
      }
      for (const addr of allAddrs) {
        if (isPrivateIp(addr)) {
          throw new Error("DNS rebinding detected — hostname resolves to private IP.");
        }
      }
    } catch (err) {
      if (err.message.includes("rebinding") || err.message.includes("no longer resolves")) throw err;
      throw new Error("Hostname could not be resolved at fetch time.");
    }
  }

  return fetch(url, {
    ...options,
    // Prevent open-redirect bypass: a 302 to http://169.254.169.254/…
    // would bypass hostname validation.
    redirect: "error",
  });
}
