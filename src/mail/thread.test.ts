import { describe, expect, it } from 'vitest'
import type { ParsedEmail } from './parse.js'
import { type Keyring, mintReplyMessageId, type SigningKey } from './reply-token.js'
import { decideThreading } from './thread.js'

// --- fixtures ---------------------------------------------------------------

const KEY_A: SigningKey = { keyId: 'k1', secret: 'secret-A-high-entropy-0123456789abcdef' }
const ring: Keyring = { current: KEY_A }

const MAIL_DOMAIN = 'mail.example.test'

/** Mint a real, verifiable reply token Message-ID for the given lineage. */
function mint(conversationId: string, threadId: string): string {
  return mintReplyMessageId({ conversationId, threadId, mailDomain: MAIL_DOMAIN }, ring)
}

/** Flip one character inside a minted token's `sig` segment to forge/tamper it. */
function forge(messageId: string): string {
  const inner = messageId.slice(1, -1)
  const [local, domain] = inner.split('@')
  const parts = local.split('.')
  const sig = parts[4]
  const flipped = sig[0] === 'A' ? 'B' : 'A'
  parts[4] = flipped + sig.slice(1)
  return `<${parts.join('.')}@${domain}>`
}

/** Minimal ParsedEmail builder — only threading-relevant fields vary per test. */
function email(
  fields: Partial<Pick<ParsedEmail, 'inReplyTo' | 'references' | 'subject'>>,
): ParsedEmail {
  return {
    messageId: '<inbound-msg-id@customer.example.test>',
    inReplyTo: fields.inReplyTo ?? null,
    references: fields.references ?? [],
    from: { address: 'customer@example.test' },
    to: [{ address: 'support@example.test' }],
    cc: [],
    subject: fields.subject ?? '',
    date: null,
    text: 'body',
    html: null,
    headers: {},
    attachments: [],
  }
}

const GMAIL_ID = '<CABc123def456ghi789jkl0mn=someone@mail.gmail.com>'

// --- rule 2: valid token in In-Reply-To -------------------------------------

describe('rule 2 — valid token appends', () => {
  // Evidence: fixtures/mail/observed/reply-with-reference.json — a customer
  // reply whose In-Reply-To points at the agent reply's Message-ID appended
  // to the same conversation (threadsCount 3→4, appendedToSameConversation).
  it('valid token in In-Reply-To → append with its conversationId/threadId', () => {
    const token = mint('c15', 't37')
    const result = decideThreading(email({ inReplyTo: token, references: [token] }), ring)
    expect(result).toEqual({
      kind: 'append',
      conversationId: 'c15',
      threadId: 't37',
      forgedTokenCount: 0,
    })
  })

  it('valid token present only in References (not In-Reply-To) → append', () => {
    const token = mint('c15', 't37')
    const result = decideThreading(email({ inReplyTo: null, references: [token] }), ring)
    expect(result).toEqual({
      kind: 'append',
      conversationId: 'c15',
      threadId: 't37',
      forgedTokenCount: 0,
    })
  })
})

// --- rule 3: forged/tampered token -----------------------------------------

describe('rule 3 — forged token does not thread', () => {
  // Evidence: fixtures/mail/observed/forged-reply-token.json — a tampered
  // token (a few characters altered from a genuine one) did not append to
  // the real conversation (appendedToRealConversation: false); a new
  // conversation was created instead (id 20).
  it('a forged/tampered token → new conversation, forgedTokenCount === 1', () => {
    const genuine = mint('c15', 't37')
    const forged = forge(genuine)
    const result = decideThreading(email({ inReplyTo: forged, references: [] }), ring)
    expect(result).toEqual({ kind: 'new', forgedTokenCount: 1 })
  })
})

// --- rule 4: no headers at all ----------------------------------------------

describe('rule 4 — no threading headers → new conversation', () => {
  // Evidence: fixtures/mail/observed/new-conversation.json — a fresh
  // message with no threading headers produced a fresh conversation.
  it('no In-Reply-To, no References → new, forgedTokenCount === 0', () => {
    const result = decideThreading(email({ inReplyTo: null, references: [] }), ring)
    expect(result).toEqual({ kind: 'new', forgedTokenCount: 0 })
  })

  // Evidence: fixtures/mail/observed/reply-subject-only.json — a
  // `Re:`-prefixed reply with a matching subject but no reference headers
  // produced a SEPARATE conversation (outcome: "split").
  it('Re:-style subject but no reference headers → new; subject is ignored', () => {
    const result = decideThreading(
      email({ inReplyTo: null, references: [], subject: 'Re: Harness reply-subject-only' }),
      ring,
    )
    expect(result).toEqual({ kind: 'new', forgedTokenCount: 0 })
  })

  // Evidence: fixtures/mail/observed/same-subject-different-customer.json —
  // an identical subject to an existing conversation, no reference headers,
  // still produced its own new conversation (outcome: "own-conversation"),
  // even when the sender turned out to be the same customer underneath.
  it('identical subject to an existing conversation, no headers → new', () => {
    const result = decideThreading(
      email({
        inReplyTo: null,
        references: [],
        subject: 'Harness same-subject-different-customer',
      }),
      ring,
    )
    expect(result).toEqual({ kind: 'new', forgedTokenCount: 0 })
  })
})

// --- rule 5: valid token wins over unrelated subject ------------------------

describe('rule 5 — valid token threads regardless of subject', () => {
  // Evidence: fixtures/mail/observed/token-authority.json — a reply
  // carrying the genuine token from reply-with-reference.json but with
  // subject "Completely unrelated subject [...]" still appended to
  // conversation 15 (appendedToRealConversation: true, newConversation: null).
  it('valid token + completely unrelated subject → still append', () => {
    const token = mint('c15', 't37')
    const result = decideThreading(
      email({ inReplyTo: token, references: [], subject: 'Completely unrelated subject' }),
      ring,
    )
    expect(result).toEqual({
      kind: 'append',
      conversationId: 'c15',
      threadId: 't37',
      forgedTokenCount: 0,
    })
  })
})

// --- ordering ----------------------------------------------------------------

describe('candidate ordering', () => {
  // specs/mail/threading.md §3 rule 1 + §5 open question: In-Reply-To names
  // the specific message being replied to and is checked before anything in
  // References.
  it('two different valid tokens: In-Reply-To wins over References', () => {
    const inReplyToToken = mint('c-in-reply-to', 't1')
    const referencesToken = mint('c-references', 't2')
    const result = decideThreading(
      email({ inReplyTo: inReplyToToken, references: [referencesToken] }),
      ring,
    )
    expect(result).toMatchObject({ kind: 'append', conversationId: 'c-in-reply-to' })
  })

  // §3 rule 1: References is oldest-first on the wire; the consumer scans
  // most-recent-first, so the LAST entry on the wire is tried first.
  it('two valid tokens in References: the most-recent (last-on-wire) one wins', () => {
    const older = mint('c-older', 't1')
    const newer = mint('c-newer', 't2')
    const result = decideThreading(email({ inReplyTo: null, references: [older, newer] }), ring)
    expect(result).toMatchObject({ kind: 'append', conversationId: 'c-newer' })
  })

  it('references reversed correctly: an old token and a newer token — newer tried first', () => {
    const oldToken = mint('c-old', 't1')
    const newToken = mint('c-new', 't2')
    // Wire order oldest-first: [oldToken, newToken]. Most-recent-first scan
    // must try newToken before oldToken.
    const result = decideThreading(
      email({ inReplyTo: null, references: [oldToken, newToken] }),
      ring,
    )
    expect(result).toMatchObject({ kind: 'append', conversationId: 'c-new', threadId: 't2' })
  })
})

// --- mixed: forged then valid ------------------------------------------------

describe('mixed candidates', () => {
  it('forged token first, valid token later → appends to the valid one, forgedTokenCount === 1', () => {
    const genuine = mint('c15', 't37')
    const forged = forge(mint('c99', 't1'))
    const result = decideThreading(email({ inReplyTo: forged, references: [genuine] }), ring)
    expect(result).toEqual({
      kind: 'append',
      conversationId: 'c15',
      threadId: 't37',
      forgedTokenCount: 1,
    })
  })
})

// --- non-token headers --------------------------------------------------------

describe('non-token headers', () => {
  it('a Gmail-style Message-ID in References → new, forgedTokenCount === 0', () => {
    const result = decideThreading(email({ inReplyTo: null, references: [GMAIL_ID] }), ring)
    expect(result).toEqual({ kind: 'new', forgedTokenCount: 0 })
  })
})

// --- CFWS / multi-id headers (Codex: In-Reply-To must be tokenized) ---------

describe('tokenized In-Reply-To (RFC 5322 CFWS / multiple ids)', () => {
  it('a valid token embedded after a comment in In-Reply-To → append', () => {
    const token = mint('c-embedded', 't1')
    const result = decideThreading(email({ inReplyTo: `(client note) ${token}` }), ring)
    expect(result).toMatchObject({ kind: 'append', conversationId: 'c-embedded', threadId: 't1' })
  })

  it('In-Reply-To with the token plus a trailing unrelated id → append to the token', () => {
    const token = mint('c-multi', 't2')
    const result = decideThreading(
      email({ inReplyTo: `${token} <unrelated@other.example.test>` }),
      ring,
    )
    expect(result).toMatchObject({ kind: 'append', conversationId: 'c-multi', threadId: 't2' })
  })

  it('leading/trailing whitespace around the token in In-Reply-To → append', () => {
    const token = mint('c-ws', 't3')
    const result = decideThreading(email({ inReplyTo: `   ${token}   ` }), ring)
    expect(result).toMatchObject({ kind: 'append', conversationId: 'c-ws', threadId: 't3' })
  })

  it('In-Reply-To token is tried before a (different) valid token in References', () => {
    const inReplyToken = mint('c-irt', 't1')
    const refToken = mint('c-ref', 't2')
    const result = decideThreading(
      email({ inReplyTo: `(note) ${inReplyToken}`, references: [refToken] }),
      ring,
    )
    expect(result).toMatchObject({ kind: 'append', conversationId: 'c-irt' })
  })

  it('a header with no angle-bracketed id contributes no candidate → new', () => {
    const result = decideThreading(email({ inReplyTo: 'garbage no brackets here' }), ring)
    expect(result).toEqual({ kind: 'new', forgedTokenCount: 0 })
  })
})
