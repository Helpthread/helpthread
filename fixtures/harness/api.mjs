// fixtures/harness/api.mjs
//
// Minimal FreeScout REST client for the harness. Read paths (list/get) are
// unrestricted; the one mutation path (postAgentReply) is marker-gated so a
// scenario can never accidentally write into a conversation it didn't
// create — see the safety-rail comment on postAgentReply below.

import { loadEnv } from './env.mjs';

function authHeaders() {
  const env = loadEnv();
  return {
    'X-FreeScout-API-Key': env.fsApiKey,
    'Content-Type': 'application/json',
  };
}

async function apiFetch(path, init = {}) {
  const env = loadEnv();
  const url = `${env.fsBaseUrl}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable body>');
    throw new Error(`harness: FreeScout API ${init.method ?? 'GET'} ${path} -> ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * List recent conversations and filter client-side by subject substring.
 * FreeScout's list endpoint doesn't support subject filtering directly, so
 * we always pull the most-recent page and filter here.
 */
export async function listConversations({ subjectContains } = {}) {
  const data = await apiFetch('/api/conversations?pageSize=50&sortField=createdAt&sortOrder=desc');
  const items = data?._embedded?.conversations ?? data?.conversations ?? data ?? [];
  if (!subjectContains) return items;
  return items.filter((c) => typeof c.subject === 'string' && c.subject.includes(subjectContains));
}

/** Fetch a single conversation with its threads embedded. */
export async function getConversation(id) {
  return apiFetch(`/api/conversations/${id}?embed=threads`);
}

/**
 * Post an agent reply into a conversation.
 *
 * SAFETY RAIL: this is the harness's only mutation against a live helpdesk,
 * so it refuses to write unless the target conversation's subject contains
 * the caller-supplied marker for the current run. This is what keeps the
 * harness from ever touching a conversation it didn't create itself.
 *
 * @param {number|string} conversationId
 * @param {string} text
 * @param {object} opts
 * @param {string} opts.marker - the current run's marker, e.g. "[HT7-abc123-reply-with-reference]"
 */
export async function postAgentReply(conversationId, text, { marker } = {}) {
  if (!marker) {
    throw new Error('harness: postAgentReply requires { marker } — refusing to mutate without a marker check');
  }

  const conversation = await getConversation(conversationId);
  const subject = conversation?.subject ?? '';
  if (!subject.includes(marker)) {
    throw new Error(
      `harness: refusing postAgentReply — conversation ${conversationId} subject "${subject}" does not contain run marker "${marker}"`,
    );
  }

  const env = loadEnv();
  return apiFetch(`/api/conversations/${conversationId}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'message',
      text,
      user: env.fsUserId,
    }),
  });
}

/**
 * Poll the conversation list until one whose subject contains
 * `subjectContains` appears, then return it with threads embedded.
 */
export async function pollForConversation({ subjectContains, timeoutMs = 240000, intervalMs = 15000 }) {
  if (!subjectContains) throw new Error('harness: pollForConversation requires subjectContains');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await listConversations({ subjectContains });
    if (matches.length > 0) {
      // Most recently created match, in case of unexpected duplicates.
      const target = matches.reduce((latest, c) =>
        !latest || new Date(c.createdAt) > new Date(latest.createdAt) ? c : latest, null);
      return getConversation(target.id);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }

  throw new Error(
    `harness: pollForConversation timed out after ${timeoutMs}ms waiting for a conversation with subject containing "${subjectContains}"`,
  );
}

/** Poll for ALL conversations matching a marker (used when a scenario needs
 * to distinguish "appended to existing" from "created a new conversation"). */
export async function pollForConversations({ subjectContains, minCount = 1, timeoutMs = 240000, intervalMs = 15000 }) {
  if (!subjectContains) throw new Error('harness: pollForConversations requires subjectContains');

  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await listConversations({ subjectContains });
    if (last.length >= minCount) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  return last;
}
