// fixtures/harness/scenarios.mjs
//
// The five black-box probes. Each scenario embeds a unique marker
// `[HT7-<runId>-<scenarioId>]` in every subject it sends, and every read
// (listConversations / pollForConversation) filters strictly by that
// marker — this is what guarantees a run can never observe, and
// postAgentReply can never mutate, a conversation it didn't create itself.
//
// ctx passed into run(ctx):
//   ctx.send(...)            -> fixtures/harness/send.mjs#sendMail
//   ctx.waitForMessage(...)  -> fixtures/harness/inbox.mjs#waitForMessage
//   ctx.api                  -> fixtures/harness/api.mjs (listConversations,
//                                getConversation, postAgentReply,
//                                pollForConversation, pollForConversations)
//   ctx.marker(tagSuffix)    -> `[HT7-<runId>-<tagSuffix>]`
//   ctx.runId                -> the run's short random id (design addition,
//                                see README: needed to build distinct
//                                per-customer plus-tags without re-parsing
//                                marker strings)

/** Generic "poll until fn() reports done" loop shared by every scenario
 * that needs to distinguish append vs. split vs. timeout. Not part of the
 * required file list — an internal helper to avoid duplicating five
 * hand-rolled poll loops. */
async function pollUntil(fn, { timeoutMs, intervalMs = 15000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    const { done, value } = await fn();
    lastValue = value;
    if (done) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  return lastValue;
}

// Shared subject builder for the "new-conversation" marker, used by BOTH
// `new-conversation` (customer A) and `same-subject-different-customer`
// (customer E) so the two scenarios independently produce the byte-identical
// subject line the spec requires, with no runtime coupling between them.
function subjectForNewConversation(marker) {
  return `Harness fresh conversation ${marker}`;
}

async function runNewConversation(ctx) {
  const marker = ctx.marker('new-conversation');
  const subject = subjectForNewConversation(marker);
  const tag = `${ctx.runId}-a`;

  const sentInitial = await ctx.send({
    fromTag: tag,
    subject,
    text: `Hello, this is a fresh test conversation. ${marker}`,
  });

  const conversation = await ctx.api.pollForConversation({ subjectContains: marker, timeoutMs: 240000 });

  return {
    sent: [sentInitial],
    observed: { conversation },
    notes: `Created conversation id=${conversation.id} with ${conversation.threads?.length ?? 'unknown'} thread(s).`,
  };
}

async function runReplyWithReference(ctx) {
  const marker = ctx.marker('reply-with-reference');
  const subject = `Harness reply-with-reference ${marker}`;
  const tag = `${ctx.runId}-b`;

  const sentInitial = await ctx.send({
    fromTag: tag,
    subject,
    text: `Initial message for reply-with-reference. ${marker}`,
  });

  const conversation = await ctx.api.pollForConversation({ subjectContains: marker, timeoutMs: 240000 });
  const conversationId = conversation.id;

  const agentReplyResponse = await ctx.api.postAgentReply(
    conversationId,
    'Thanks — can you share more detail?',
    { marker },
  );

  const outboundAgentReply = await ctx.waitForMessage({ toPlusTag: tag, subjectContains: marker, timeoutMs: 240000 });

  const beforeThreadCount = (await ctx.api.getConversation(conversationId)).threads?.length ?? 0;

  const replySubject = `Re: ${subject}`;
  const referencesHeader = [outboundAgentReply.references, outboundAgentReply.messageId]
    .filter(Boolean)
    .join(' ');

  const sentReply = await ctx.send({
    fromTag: tag,
    subject: replySubject,
    text: `Sure — here's more detail. ${marker}`,
    headers: {
      // Guard against a null messageId (inbox parser fallback) becoming the
      // literal string "null" in the header and corrupting the threading probe.
      ...(outboundAgentReply.messageId ? { 'In-Reply-To': outboundAgentReply.messageId } : {}),
      ...(referencesHeader ? { References: referencesHeader } : {}),
    },
  });

  const result = await pollUntil(async () => {
    const matches = await ctx.api.listConversations({ subjectContains: marker });
    const sameConv = matches.find((m) => m.id === conversationId);
    if (sameConv) {
      const full = await ctx.api.getConversation(conversationId);
      if ((full.threads?.length ?? 0) > beforeThreadCount) {
        return { done: true, value: { outcome: 'appended', conversation: full, allMatches: matches } };
      }
    }
    const otherConv = matches.find((m) => m.id !== conversationId);
    if (otherConv) {
      const full = await ctx.api.getConversation(otherConv.id);
      return { done: true, value: { outcome: 'split', conversation: full, allMatches: matches } };
    }
    return { done: false, value: { outcome: 'pending', allMatches: matches } };
  }, { timeoutMs: 240000, intervalMs: 15000 });

  return {
    sent: [sentInitial, sentReply],
    observed: {
      conversationId,
      agentReplyResponse,
      outboundAgentReply,
      result,
    },
    notes:
      result?.outcome === 'appended'
        ? `Threaded customer reply appended to original conversation ${conversationId}.`
        : result?.outcome === 'split'
          ? `Threaded customer reply created a separate conversation instead of appending to ${conversationId}.`
          : `Timed out without observing the customer reply take effect on conversation ${conversationId}.`,
  };
}

async function runReplySubjectOnly(ctx) {
  const marker = ctx.marker('reply-subject-only');
  const subject = `Harness reply-subject-only ${marker}`;
  const tag = `${ctx.runId}-c`;

  const sentInitial = await ctx.send({
    fromTag: tag,
    subject,
    text: `Initial message for reply-subject-only. ${marker}`,
  });

  const conversation = await ctx.api.pollForConversation({ subjectContains: marker, timeoutMs: 240000 });
  const conversationId = conversation.id;
  const initialThreadCount = conversation.threads?.length ?? 0;

  const replySubject = `Re: ${subject}`;
  const sentReply = await ctx.send({
    fromTag: tag,
    subject: replySubject,
    text: `Follow-up with no In-Reply-To/References. ${marker}`,
  });

  const result = await pollUntil(async () => {
    const matches = await ctx.api.listConversations({ subjectContains: marker });
    if (matches.length >= 2) {
      const conversations = await Promise.all(matches.map((m) => ctx.api.getConversation(m.id)));
      return { done: true, value: { outcome: 'split', conversations } };
    }
    const full = await ctx.api.getConversation(conversationId);
    if ((full.threads?.length ?? 0) > initialThreadCount) {
      return { done: true, value: { outcome: 'appended', conversations: [full] } };
    }
    return { done: false, value: { outcome: 'pending', conversations: [full] } };
  }, { timeoutMs: 150000, intervalMs: 15000 }); // up to 2.5 min per spec

  return {
    sent: [sentInitial, sentReply],
    observed: { conversationId, result },
    notes:
      result?.outcome === 'appended'
        ? `Subject-only "Re:" reply appended to original conversation ${conversationId}.`
        : result?.outcome === 'split'
          ? `Subject-only "Re:" reply created a separate conversation from ${conversationId}.`
          : `Timed out after 2.5 min without observing append or split for conversation ${conversationId}.`,
  };
}

async function runAutoSubmitted(ctx) {
  const marker = ctx.marker('auto-submitted');
  const subject = `Harness auto-submitted ${marker}`;
  const tag = `${ctx.runId}-d`;

  const sentInitial = await ctx.send({
    fromTag: tag,
    subject,
    text: `Auto-submitted probe. ${marker}`,
    headers: { 'Auto-Submitted': 'auto-replied' },
  });

  let conversation = null;
  let outcome;
  try {
    conversation = await ctx.api.pollForConversation({ subjectContains: marker, timeoutMs: 240000 });
    outcome = 'created';
  } catch {
    outcome = 'absent';
  }

  return {
    sent: [sentInitial],
    observed: { outcome, conversation },
    notes:
      outcome === 'created'
        ? `A conversation WAS created for an "Auto-Submitted: auto-replied" message (id ${conversation.id}).`
        : 'No conversation appeared within the timeout for an "Auto-Submitted: auto-replied" message — absence recorded as the observation.',
  };
}

async function runSameSubjectDifferentCustomer(ctx) {
  // Deliberately reuse the SAME marker/subject as `new-conversation` (tag A)
  // by asking for tagSuffix 'new-conversation' explicitly — this is what
  // makes the subjects byte-identical within a run while staying unique
  // across runs (marker embeds runId).
  const sharedMarker = ctx.marker('new-conversation');
  const subject = subjectForNewConversation(sharedMarker);
  const tag = `${ctx.runId}-e`;

  // Snapshot state before sending: expect to find A's conversation here,
  // since scenarios run sequentially and new-conversation runs first.
  const before = await ctx.api.listConversations({ subjectContains: sharedMarker });
  const priorConversationId = before[0]?.id ?? null;
  // This scenario reuses new-conversation's subject and depends on it having
  // run first this session. Run standalone via --only, `before` is empty and
  // the result would trivially (and misleadingly) read 'own-conversation'.
  if (!priorConversationId) {
    throw new Error(
      'same-subject-different-customer requires new-conversation to have run first this session — run the full suite, not --only for this scenario alone',
    );
  }
  const priorThreadCount =
    (await ctx.api.getConversation(priorConversationId)).threads?.length ?? 0;

  const sentInitial = await ctx.send({
    fromTag: tag,
    subject,
    text: `Different customer, identical subject to scenario A. ${sharedMarker}`,
  });

  const result = await pollUntil(async () => {
    const matches = await ctx.api.listConversations({ subjectContains: sharedMarker });
    if (matches.length > before.length) {
      const conversations = await Promise.all(matches.map((m) => ctx.api.getConversation(m.id)));
      return { done: true, value: { outcome: 'own-conversation', conversations, allMatches: matches } };
    }
    if (priorConversationId) {
      const full = await ctx.api.getConversation(priorConversationId);
      if ((full.threads?.length ?? 0) > priorThreadCount) {
        return { done: true, value: { outcome: 'merged-into-a', conversation: full, allMatches: matches } };
      }
    }
    return { done: false, value: { outcome: 'pending', allMatches: matches } };
  }, { timeoutMs: 240000, intervalMs: 15000 });

  return {
    sent: [sentInitial],
    observed: { priorConversationId, before, result },
    notes:
      result?.outcome === 'merged-into-a'
        ? `Landed in the same conversation as scenario A (id ${priorConversationId}) despite a different customer address.`
        : result?.outcome === 'own-conversation'
          ? `Created its own conversation, distinct from scenario A's (id ${priorConversationId ?? 'unknown — A may not have been observed'}).`
          : `Timed out without a clear observation; inspect observed.before / observed.result.`,
  };
}

export const scenarios = [
  {
    id: 'new-conversation',
    title: 'Fresh email creates a new conversation',
    expectation: 'A brand-new, uniquely-marked email creates exactly one new conversation visible via the API.',
    run: runNewConversation,
  },
  {
    id: 'reply-with-reference',
    title: 'Customer reply with In-Reply-To/References threads correctly',
    expectation:
      'After an agent reply, a customer reply carrying In-Reply-To/References pointing at the outbound Message-ID appends to the same conversation.',
    run: runReplyWithReference,
  },
  {
    id: 'reply-subject-only',
    title: 'Customer reply with only a "Re:" subject (no reference headers)',
    expectation:
      'A "Re:" reply with no In-Reply-To/References may or may not thread correctly by subject alone — observed, not assumed.',
    run: runReplySubjectOnly,
  },
  {
    id: 'auto-submitted',
    title: 'Auto-Submitted: auto-replied message handling',
    expectation:
      'An email marked Auto-Submitted: auto-replied may be suppressed (no conversation) or ingested normally — observed, not assumed.',
    run: runAutoSubmitted,
  },
  {
    id: 'same-subject-different-customer',
    title: 'Different customer, identical subject to an existing conversation',
    expectation:
      'A new sender using the exact subject of an existing conversation may merge into it or create its own — observed, not assumed.',
    run: runSameSubjectDifferentCustomer,
  },
];
