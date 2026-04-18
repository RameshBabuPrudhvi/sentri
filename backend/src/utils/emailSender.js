/**
 * @module utils/emailSender
 * @description Email transport abstraction for transactional emails.
 *
 * Supports three transports selected by environment variables:
 *   1. **Resend** — set `RESEND_API_KEY` (recommended for production).
 *   2. **SMTP**   — set `SMTP_HOST` + `SMTP_PORT` (+ optional `SMTP_USER`, `SMTP_PASS`).
 *   3. **Console** — fallback when neither is configured (dev/test only).
 *
 * All transports expose the same `sendEmail()` interface so callers never
 * need to know which transport is active.
 */

import { formatLogLine } from "./logFormatter.js";

/**
 * Escape HTML special characters to prevent injection in email templates.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @typedef {Object} EmailPayload
 * @property {string}  to      - Recipient email address.
 * @property {string}  subject - Email subject line.
 * @property {string}  html    - HTML body.
 * @property {string}  [text]  - Plain-text fallback body.
 */

/**
 * Detect which transport is configured and return a send function.
 * @returns {Object} `{ name: string, send: Function }`
 */
function detectTransport() {
  if (process.env.RESEND_API_KEY) {
    return { name: "resend", send: sendViaResend };
  }
  if (process.env.SMTP_HOST) {
    return { name: "smtp", send: sendViaSmtp };
  }
  return { name: "console", send: sendViaConsole };
}

/**
 * Send an email using the Resend HTTP API.
 * @param {EmailPayload} payload
 */
async function sendViaResend({ to, subject, html, text }) {
  const from = process.env.EMAIL_FROM || "Sentri <noreply@sentri.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

/**
 * Send an email using SMTP via Node's built-in net module.
 * Uses a minimal SMTP client — for production, consider nodemailer.
 * Falls back to console logging if the connection fails.
 *
 * @param {EmailPayload} payload
 */
async function sendViaSmtp({ to, subject, html, text }) {
  // Dynamically import nodemailer only when SMTP is configured.
  // If nodemailer is not installed, fall back to console transport.
  let nodemailer;
  try {
    nodemailer = await import("nodemailer");
  } catch {
    console.warn(formatLogLine("warn", null, "[email] nodemailer not installed — falling back to console transport. Run `npm install nodemailer` to enable SMTP."));
    return sendViaConsole({ to, subject, html, text });
  }

  const transporter = nodemailer.default.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS || "",
    } : undefined,
  });

  const from = process.env.EMAIL_FROM || "Sentri <noreply@sentri.dev>";
  await transporter.sendMail({ from, to, subject, html, text });
}

/**
 * Console fallback — logs the email to stdout for development.
 * @param {EmailPayload} payload
 */
async function sendViaConsole({ to, subject, html }) {
  console.log(formatLogLine("info", null, `[email/console] To: ${to} | Subject: ${subject}`));
  if (process.env.NODE_ENV !== "production") {
    // Strip HTML tags for a readable console preview
    const preview = html.replace(/<[^>]+>/g, "").slice(0, 500);
    console.log(formatLogLine("info", null, `[email/console] Body preview: ${preview}`));
  }
}

const transport = detectTransport();

/**
 * Send a transactional email using the configured transport.
 *
 * @param {EmailPayload} payload - Email to send.
 * @returns {Promise<void>}
 * @throws {Error} If the transport fails (caller should handle gracefully).
 */
export async function sendEmail(payload) {
  await transport.send(payload);
}

/**
 * Send a verification email to a newly registered user.
 *
 * @param {string} email     - Recipient email address.
 * @param {string} token     - The verification token.
 * @param {string} userName  - User's display name for personalisation.
 * @returns {Promise<void>}
 */
export async function sendVerificationEmail(email, token, userName) {
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const basePath = (process.env.APP_BASE_PATH || "/").replace(/\/$/, "");
  const verifyUrl = `${appUrl}${basePath}/login?verify=${token}`;

  const subject = "Verify your Sentri account";
  const safeName = escapeHtml(userName);
  const safeUrl = escapeHtml(verifyUrl);
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
      <h2 style="margin: 0 0 16px; font-size: 20px; color: #0f172a;">Welcome to Sentri${safeName ? `, ${safeName}` : ""}!</h2>
      <p style="margin: 0 0 24px; font-size: 14px; color: #475569; line-height: 1.6;">
        Click the button below to verify your email address and activate your account.
        This link expires in 24 hours.
      </p>
      <a href="${safeUrl}" style="display: inline-block; padding: 12px 28px; background: #6366f1; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
        Verify Email Address
      </a>
      <p style="margin: 24px 0 0; font-size: 12px; color: #94a3b8; line-height: 1.5;">
        If you didn't create a Sentri account, you can safely ignore this email.<br/>
        Link: <a href="${safeUrl}" style="color: #6366f1; word-break: break-all;">${safeUrl}</a>
      </p>
    </div>
  `;
  const text = `Welcome to Sentri${userName ? `, ${userName}` : ""}!\n\nVerify your email: ${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you didn't create a Sentri account, ignore this email.`;

  await sendEmail({ to: email, subject, html, text });

  if (process.env.NODE_ENV !== "production") {
    console.log(formatLogLine("info", null, `[email] Verification link for ${email}: ${verifyUrl}`));
  }
}

/**
 * Get the name of the active email transport.
 * @returns {string} `"resend"` | `"smtp"` | `"console"`.
 */
export function getTransportName() {
  return transport.name;
}
