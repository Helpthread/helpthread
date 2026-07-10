// fixtures/harness/send.mjs
//
// Sends probe emails via Gmail SMTP (smtp.gmail.com:465, implicit TLS),
// authenticated as HARNESS_SMTP_USER. Every send uses a plus-addressed
// From (user+<tag>@gmail.com) so scenarios can simulate distinct customers
// from a single Gmail account, and so inbox.mjs can later filter the
// helpdesk's outbound replies by recipient tag.

import nodemailer from 'nodemailer';
import { loadEnv } from './env.mjs';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const env = loadEnv();
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass,
    },
  });
  return transporter;
}

/**
 * Build a plus-addressed sender address from HARNESS_SMTP_USER, e.g.
 * "alice@gmail.com" + tag "abc123" -> "alice+abc123@gmail.com".
 */
export function plusAddress(tag) {
  const env = loadEnv();
  const at = env.smtpUser.indexOf('@');
  if (at === -1) {
    throw new Error(`harness: HARNESS_SMTP_USER is not a valid email address: ${env.smtpUser}`);
  }
  const local = env.smtpUser.slice(0, at);
  const domain = env.smtpUser.slice(at + 1);
  // Strip any pre-existing +tag on the base local part so plusAddress is
  // idempotent even if HARNESS_SMTP_USER itself is already plus-addressed.
  const bareLocal = local.split('+')[0];
  return `${bareLocal}+${tag}@${domain}`;
}

/**
 * Send a probe email to the helpdesk (or wherever `to` points).
 *
 * @param {object} opts
 * @param {string} opts.fromTag - tag used to derive the plus-addressed From
 * @param {string} opts.subject
 * @param {string} opts.text
 * @param {string} [opts.to] - defaults to HARNESS_HELPDESK_ADDR
 * @param {Record<string,string>} [opts.headers] - extra raw headers
 *   (In-Reply-To, References, Auto-Submitted, ...)
 * @returns {Promise<{from: string, to: string, subject: string, messageId: string, envelope: object}>}
 */
export async function sendMail({ fromTag, subject, text, html, to, headers }) {
  if (!fromTag) throw new Error('harness: sendMail requires fromTag');
  if (!subject) throw new Error('harness: sendMail requires subject');

  const env = loadEnv();
  const from = plusAddress(fromTag);
  const recipient = to ?? env.helpdeskAddr;

  const info = await getTransporter().sendMail({
    from,
    to: recipient,
    subject,
    text: text ?? '',
    ...(html ? { html } : {}),
    headers: headers ?? {},
  });

  return {
    from,
    to: recipient,
    subject,
    text: text ?? '',
    headers: headers ?? {},
    messageId: info.messageId,
    envelope: info.envelope,
  };
}
