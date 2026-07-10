// fixtures/harness/inbox.mjs
//
// Reads back the helpdesk's OUTBOUND reply email via IMAP against the same
// Gmail account used to send probes. This is how a scenario captures the
// Message-ID FreeScout puts on its reply, so a follow-up "customer reply"
// can be crafted with a correct In-Reply-To / References chain.
//
// Deliberately dependency-light: imapflow gives us envelope/search, but per
// the harness design we fetch the raw RFC822 source and parse the headers
// (and a body snippet) ourselves rather than pulling in a MIME parser.

import { ImapFlow } from 'imapflow';
import { loadEnv } from './env.mjs';
import { plusAddress } from './send.mjs';

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

async function openClient() {
  const env = loadEnv();
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: env.smtpUser, pass: env.smtpPass },
    logger: false,
  });
  await client.connect();
  return client;
}

/** Find Gmail's "All Mail" folder by special-use flag, falling back to the
 * conventional English path if the special-use list lookup fails. */
async function resolveAllMailPath(client) {
  try {
    const list = await client.list();
    const allMail = list.find((box) => box.specialUse === '\\All');
    if (allMail) return allMail.path;
  } catch {
    // fall through to the conventional default
  }
  return '[Gmail]/All Mail';
}

function parseRawMessage(source) {
  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  const splitIdx = raw.search(/\r?\n\r?\n/);
  const headerBlock = splitIdx === -1 ? raw : raw.slice(0, splitIdx);
  const bodyBlock = splitIdx === -1 ? '' : raw.slice(splitIdx).replace(/^(\r?\n)+/, '');

  const headers = {};
  let currentName = null;
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentName) {
      headers[currentName] += ' ' + line.trim();
      continue;
    }
    const m = line.match(/^([^:\s][^:]*):\s?(.*)$/);
    if (m) {
      currentName = m[1].trim().toLowerCase();
      headers[currentName] = m[2].trim();
    } else {
      currentName = null;
    }
  }

  // Minimal, non-MIME-aware snippet: strip obvious boundary/encoding noise
  // and take the first chunk of readable text. Good enough for provenance
  // in a fixture, not a substitute for real MIME decoding.
  const textSnippet = bodyBlock
    .replace(/--[-\w=]+(--)?/g, ' ')
    .replace(/^(Content-[\w-]+:.*|[\w-]+:\s*[\w/;= "-]+)$/gim, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  return {
    messageId: headers['message-id'] ?? null,
    inReplyTo: headers['in-reply-to'] ?? null,
    references: headers['references'] ?? null,
    subject: headers['subject'] ?? null,
    from: headers['from'] ?? null,
    to: headers['to'] ?? null,
    date: headers['date'] ?? null,
    autoSubmitted: headers['auto-submitted'] ?? null,
    textSnippet,
  };
}

/**
 * Search one mailbox for a message whose subject contains `subjectContains`.
 * Returns the parsed message for the most recent match, or null.
 *
 * Deliberately does NOT filter on the To header: Gmail's SMTP submission
 * rewrites plus-addressed From values to the canonical account address, so
 * the helpdesk replies to the base address and a plus-tagged To filter never
 * matches (learned the hard way in run 23ad1ec4). Run markers are unique per
 * run+scenario, so subject-only matching is precise.
 */
async function searchMailbox(client, path, toAddress, subjectContains) {
  const lock = await client.getMailboxLock(path);
  try {
    const uids = await client.search(
      { subject: subjectContains },
      { uid: true },
    );
    if (!uids || uids.length === 0) return null;

    // Most recent match: UIDs increase monotonically within a mailbox.
    const uid = uids[uids.length - 1];
    const message = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!message?.source) return null;
    return parseRawMessage(message.source);
  } finally {
    lock.release();
  }
}

/**
 * Poll INBOX (then Gmail's All Mail as a fallback) until a message
 * addressed to the plus-tagged address, with a subject containing
 * `subjectContains`, shows up.
 *
 * @param {object} opts
 * @param {string} opts.toPlusTag - the tag whose plus-address received the mail
 * @param {string} opts.subjectContains - marker substring to match in Subject
 * @param {number} [opts.timeoutMs=240000]
 * @param {number} [opts.pollIntervalMs=10000]
 * @returns {Promise<object>} parsed message: {messageId, inReplyTo, references,
 *   subject, from, to, date, textSnippet, autoSubmitted}
 */
export async function waitForMessage({
  toPlusTag,
  subjectContains,
  timeoutMs = 240000,
  pollIntervalMs = 10000,
}) {
  if (!toPlusTag) throw new Error('harness: waitForMessage requires toPlusTag');
  if (!subjectContains) throw new Error('harness: waitForMessage requires subjectContains');

  const toAddress = plusAddress(toPlusTag);
  const deadline = Date.now() + timeoutMs;
  let allMailPath = null;

  while (Date.now() < deadline) {
    let client;
    try {
      client = await openClient();
      const found = await searchMailbox(client, 'INBOX', toAddress, subjectContains);
      if (found) return found;

      allMailPath ??= await resolveAllMailPath(client);
      const foundAllMail = await searchMailbox(client, allMailPath, toAddress, subjectContains);
      if (foundAllMail) return foundAllMail;
    } catch {
      // Transient connect/auth/search failure (network blip, Gmail throttling):
      // keep polling until the deadline rather than aborting the whole wait.
    } finally {
      await client?.logout().catch(() => {});
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }

  throw new Error(
    `harness: waitForMessage timed out after ${timeoutMs}ms waiting for a message to ${toAddress} with subject containing "${subjectContains}"`,
  );
}
