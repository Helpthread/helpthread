#!/usr/bin/env node
// fixtures/harness/run.mjs
//
// Orchestrator: validates env, generates a run id, runs the five scenarios
// SEQUENTIALLY against the live helpdesk (they share one mailbox — parallel
// sends would confound IMAP polling), redacts each result, and writes one
// fixture per scenario to fixtures/mail/observed/<scenarioId>.json.
//
// Usage:
//   npm run fixtures:run                       # run all five scenarios
//   npm run fixtures:run -- --only reply-with-reference
//   npm run fixtures:run -- --dry-run          # print the plan, send nothing
//
// See fixtures/harness/README.md for required environment variables and
// safety rules before running this for real — it sends real email and
// creates real helpdesk conversations.

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './env.mjs';
import { sendMail } from './send.mjs';
import { waitForMessage } from './inbox.mjs';
import * as api from './api.mjs';
import { redact } from './redact.mjs';
import { scenarios } from './scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../mail/observed');

function parseArgs(argv) {
  let only = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') {
      only = argv[++i];
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }
  return { only, dryRun };
}

function buildRealCtx(runId) {
  return {
    runId,
    marker: (tagSuffix) => `[HT7-${runId}-${tagSuffix}]`,
    send: sendMail,
    waitForMessage,
    api,
  };
}

/** Dry-run ctx: every call logs what WOULD happen and returns a plausible
 * stub, so a scenario's full control flow (including its poll conditions)
 * exercises without ever touching SMTP/IMAP/the FreeScout API. Lets
 * --dry-run work with zero credentials configured.
 *
 * IMPORTANT: several scenarios poll in a loop until they observe "growth"
 * (a conversation's thread count increasing) before returning — that's real
 * behavior we want the dry run to exercise, but with static stub data those
 * loops would never see growth and would spin for their full real-world
 * timeout (up to 4 minutes) even in dry-run. `getConversation` therefore
 * returns a thread list that grows by one on every call (module-scoped
 * counter), so any "did the count go up since I last checked" condition is
 * satisfied on the very first poll iteration. */
function buildDryRunCtx(runId) {
  const marker = (tagSuffix) => `[HT7-${runId}-${tagSuffix}]`;
  let threadCounter = 0;
  return {
    runId,
    marker,
    send: async (opts) => {
      console.log(
        `[dry-run] would send mail: from-tag="${opts.fromTag}" subject="${opts.subject}" headers=${JSON.stringify(opts.headers ?? {})}`,
      );
      return {
        from: `<dry-run:${opts.fromTag}>`,
        to: '<dry-run:helpdesk>',
        subject: opts.subject,
        text: opts.text ?? '',
        headers: opts.headers ?? {},
        messageId: '<dry-run-message-id>',
        envelope: {},
      };
    },
    waitForMessage: async (opts) => {
      console.log(`[dry-run] would wait for inbound message: ${JSON.stringify(opts)}`);
      return {
        messageId: '<dry-run-message-id>',
        inReplyTo: null,
        references: null,
        subject: opts.subjectContains,
        from: '<dry-run:helpdesk>',
        to: `<dry-run:${opts.toPlusTag}>`,
        date: new Date().toISOString(),
        textSnippet: '<dry-run>',
      };
    },
    api: {
      listConversations: async (opts) => {
        console.log(`[dry-run] would list conversations: ${JSON.stringify(opts)}`);
        return [{ id: 'dry-run-conv', subject: opts.subjectContains ?? '<dry-run>', createdAt: new Date().toISOString() }];
      },
      getConversation: async (id) => {
        threadCounter += 1;
        console.log(`[dry-run] would get conversation ${id} (simulated thread count: ${threadCounter})`);
        return { id, subject: '<dry-run>', threads: Array.from({ length: threadCounter }, (_, i) => ({ id: i + 1 })) };
      },
      postAgentReply: async (id, text) => {
        console.log(`[dry-run] would post agent reply to conversation ${id}: "${text}"`);
        return { id: '<dry-run-thread-id>' };
      },
      pollForConversation: async (opts) => {
        console.log(`[dry-run] would poll for conversation: ${JSON.stringify(opts)}`);
        return { id: 'dry-run-conv', subject: opts.subjectContains, threads: [] };
      },
      pollForConversations: async (opts) => {
        console.log(`[dry-run] would poll for conversations: ${JSON.stringify(opts)}`);
        return [];
      },
    },
  };
}

async function writeFixture(scenarioId, payload) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${scenarioId}.json`);
  await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return file;
}

async function main() {
  const { only, dryRun } = parseArgs(process.argv.slice(2));

  const toRun = only ? scenarios.filter((s) => s.id === only) : scenarios;
  if (only && toRun.length === 0) {
    console.error(
      `[harness] unknown scenario id "${only}". Known ids: ${scenarios.map((s) => s.id).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  // Dry runs never touch SMTP/IMAP/the API, so they don't need credentials.
  const envConfig = dryRun ? null : loadEnv();

  const runId = randomBytes(4).toString('hex');
  console.log(`[harness] run id: ${runId}${dryRun ? ' (DRY RUN — sending nothing)' : ''}`);
  console.log(`[harness] scenarios to run: ${toRun.map((s) => s.id).join(', ')}`);

  const ctx = dryRun ? buildDryRunCtx(runId) : buildRealCtx(runId);
  const summary = [];

  for (const scenario of toRun) {
    console.log(`\n[harness] === ${scenario.id} === ${scenario.title}`);
    const startedAt = Date.now();

    if (dryRun) {
      try {
        await scenario.run(ctx);
        const ms = Date.now() - startedAt;
        console.log(`[harness] (dry run) ${scenario.id} plan OK in ${ms}ms`);
        summary.push({ id: scenario.id, outcome: 'dry-run-ok', ms });
      } catch (err) {
        const ms = Date.now() - startedAt;
        console.error(`[harness] (dry run) ${scenario.id} plan FAILED: ${err.message}`);
        summary.push({ id: scenario.id, outcome: 'dry-run-error', ms });
      }
      continue;
    }

    let payload;
    let outcome;
    try {
      const result = await scenario.run(ctx);
      const redacted = redact(
        { sent: result.sent, observed: result.observed, notes: result.notes },
        { smtpUser: envConfig.smtpUser, helpdeskAddr: envConfig.helpdeskAddr },
      );
      payload = {
        scenario: scenario.id,
        title: scenario.title,
        expectation: scenario.expectation,
        runId,
        recordedAt: new Date().toISOString(),
        ...redacted,
      };
      outcome = 'recorded';
      console.log(`[harness] ${scenario.id} recorded OK in ${Date.now() - startedAt}ms`);
    } catch (err) {
      outcome = 'timeout-or-error';
      payload = {
        scenario: scenario.id,
        title: scenario.title,
        expectation: scenario.expectation,
        runId,
        recordedAt: new Date().toISOString(),
        outcome: 'timeout-or-error',
        error: err.message,
      };
      console.error(`[harness] ${scenario.id} FAILED after ${Date.now() - startedAt}ms: ${err.message}`);
    }

    const file = await writeFixture(scenario.id, payload);
    console.log(`[harness] wrote ${path.relative(process.cwd(), file)}`);
    summary.push({ id: scenario.id, outcome, ms: Date.now() - startedAt });
  }

  console.log('\n[harness] run summary:');
  console.table(summary);
}

main().catch((err) => {
  console.error('[harness] fatal error:', err);
  process.exitCode = 1;
});
