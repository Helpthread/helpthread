'use client'

/**
 * One conversation: header (subject, status, close/reopen), the thread as
 * full-bleed MessageBands (design-system rule: bands, not chat bubbles),
 * and the reply composer.
 *
 * The composer implements spec §4a's client contract faithfully:
 * - ONE Idempotency-Key per logical send, minted when the draft starts and
 *   reused verbatim on every retry — a 409 `retry_in_progress` or a network
 *   failure never mints a new key (that would risk a duplicate send).
 * - `send_failed` (502) keeps the draft and says exactly what is true:
 *   nothing reached the customer.
 * - Only a SUCCESS clears the draft and rotates the key.
 */

import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'
import { sendReplyAction, setStatusAction } from '../lib/actions'
import type { ConversationDetail, ConversationStatus } from '../lib/api-types'
import { nameFromEmail, relativeTime } from '../lib/format'
import { Button } from './ds/core/Button'
import { StatusPill } from './ds/core/StatusPill'
import { TagChip } from './ds/core/TagChip'
import { MessageBand } from './ds/inbox/MessageBand'
import { ToolbarBand } from './ds/inbox/ToolbarBand'
import { SanitizedHtml } from './SanitizedHtml'

const MAX_REPLY_LENGTH = 5000

export function ConversationScreen({ conversation }: { conversation: ConversationDetail }) {
  const router = useRouter()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  // One key per logical send (spec §4a) — rotated only on success.
  const idempotencyKey = useRef<string>(crypto.randomUUID())

  function send() {
    const text = draft
    if (text.length < 1 || text.length > MAX_REPLY_LENGTH) return
    setError(null)
    startTransition(async () => {
      const result = await sendReplyAction(conversation.id, text, idempotencyKey.current)
      if (result.ok) {
        setDraft('')
        idempotencyKey.current = crypto.randomUUID()
        router.refresh()
        return
      }
      // Honest failure copy per the design system's content rules; the
      // draft is preserved in all three cases, and the SAME key retries.
      if (result.code === 'send_failed') {
        setError('Nothing reached the customer. The draft is preserved — try again.')
      } else if (result.code === 'retry_in_progress') {
        setError('This reply is already being sent. Give it a moment, then try again.')
      } else {
        setError(result.message ?? 'Something went wrong. The draft is preserved.')
      }
    })
  }

  function changeStatus(status: ConversationStatus) {
    startTransition(async () => {
      const result = await setStatusAction(conversation.id, status)
      if (result.ok) router.refresh()
    })
  }

  const customerName = nameFromEmail(conversation.customerEmail)

  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--ht-surface)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <ToolbarBand>
        <button
          type="button"
          onClick={() => router.push('/inbox/open')}
          style={{
            border: 'none',
            background: 'none',
            color: 'var(--ht-ink-muted)',
            fontSize: 13,
            cursor: 'pointer',
            padding: '4px 6px',
          }}
        >
          ← Inbox
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, marginLeft: 4 }}>{conversation.subject}</span>
        <span
          style={{
            fontFamily: 'var(--ht-mono)',
            fontSize: 11.5,
            color: 'var(--ht-ink-dim)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          #{conversation.number}
        </span>
        <StatusPill status={conversation.status} />
        {conversation.tags.map((tag) => (
          <TagChip key={tag} label={tag} />
        ))}
        <span style={{ flex: 1 }} />
        {conversation.status === 'closed' || conversation.status === 'spam' ? (
          <Button variant="outline" disabled={isPending} onClick={() => changeStatus('active')}>
            Reopen
          </Button>
        ) : (
          <Button variant="outline" disabled={isPending} onClick={() => changeStatus('closed')}>
            Close
          </Button>
        )}
      </ToolbarBand>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {conversation.threads.map((thread, index) => {
          const prev = conversation.threads[index - 1]
          const kind = thread.direction
          return (
            <MessageBand
              key={thread.id}
              kind={kind}
              fromLabel={
                kind === 'inbound' ? customerName : kind === 'note' ? 'Internal note' : 'You'
              }
              fromAddr={thread.from}
              time={relativeTime(thread.createdAt)}
              delivery={thread.deliveryStatus ?? undefined}
              failed={thread.deliveryStatus === 'failed'}
              viewedAt={
                thread.customerViewedAt !== null ? relativeTime(thread.customerViewedAt) : undefined
              }
              sameSpeakerAsPrev={prev !== undefined && prev.direction === kind}
              email={kind === 'inbound' ? conversation.customerEmail : thread.from}
            >
              {thread.bodyHtml !== null ? (
                <SanitizedHtml html={thread.bodyHtml} />
              ) : (
                (thread.bodyText ?? '')
              )}
            </MessageBand>
          )
        })}
      </div>

      <div
        style={{
          margin: 14,
          borderRadius: 'var(--ht-radius-lg, 8px)',
          border: '1px solid var(--ht-border)',
          background: 'var(--ht-surface)',
          boxShadow: 'var(--ht-shadow-md, 0 2px 10px rgba(0,0,0,0.06))',
          padding: 12,
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Reply to ${customerName}…`}
          rows={4}
          maxLength={MAX_REPLY_LENGTH}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            border: 'none',
            outline: 'none',
            resize: 'vertical',
            font: 'inherit',
            fontSize: 14,
            lineHeight: 1.6,
            background: 'transparent',
            color: 'var(--ht-ink)',
          }}
        />
        {error !== null && (
          <div
            style={{ marginTop: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--ht-critical)' }}
          >
            {error}
          </div>
        )}
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              fontSize: 11.5,
              color: 'var(--ht-ink-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {draft.length}/{MAX_REPLY_LENGTH}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="primary" disabled={isPending || draft.length === 0} onClick={send}>
            {isPending ? 'Sending…' : 'Send reply'}
          </Button>
        </div>
      </div>
    </main>
  )
}
