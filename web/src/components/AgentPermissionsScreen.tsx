'use client'

/**
 * `/manage/agents/{id}/permissions` — admin-only (HT-54 fidelity
 * correction, TJ's 2026-07-18 admin-IA review; specs/auth/agents-and-
 * auth.md §6 "Mailbox access", §3.4). FreeScout-modelled: a heading naming
 * the target Agent, All/None quick links, one checkbox per mailbox (the
 * address as its label), and Save. **Admins have implicit access to every
 * mailbox** (FreeScout's own rule, spec §3.4) — an admin target renders the
 * note instead of checkboxes, never an editable (and misleading) list.
 * **NEW designed surface — requires TJ fidelity sign-off.**
 */

import type { CSSProperties } from 'react'
import { useState, useTransition } from 'react'
import { putAgentMailboxesAction } from '../lib/agent-actions'
import type { Agent, MailboxSummary } from '../lib/api-types'
import { Button } from './ds/core/Button'
import { useToast } from './Toaster'

function quickLinkStyle(): CSSProperties {
  return {
    border: 'none',
    background: 'none',
    padding: 0,
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--ht-accent)',
    cursor: 'pointer',
  }
}

export function AgentPermissionsScreen({
  agent,
  mailboxes,
  initialMailboxIds,
}: {
  agent: Agent
  /** Omitted (not fetched) when `agent.role === 'admin'` — the note renders instead. */
  mailboxes: MailboxSummary[]
  initialMailboxIds: string[]
}) {
  const showToast = useToast()
  const [isPending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialMailboxIds))

  const isAdminTarget = agent.role === 'admin'

  function toggle(mailboxId: string): void {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(mailboxId)) {
        next.delete(mailboxId)
      } else {
        next.add(mailboxId)
      }
      return next
    })
  }

  function save(): void {
    if (isPending) return
    startTransition(async () => {
      const result = await putAgentMailboxesAction(agent.id, Array.from(selected))
      if (!result.ok) {
        showToast({ title: "Couldn't save", detail: result.message })
        return
      }
      showToast({ title: 'Mailbox access saved' })
    })
  }

  return (
    <div style={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
        {agent.name} has access to the selected mailboxes:
      </h1>

      {isAdminTarget ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ht-ink-muted)' }}>
          Admins have access to all mailboxes.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 14 }}>
            <button
              type="button"
              style={quickLinkStyle()}
              onClick={() => setSelected(new Set(mailboxes.map((mailbox) => mailbox.id)))}
            >
              All
            </button>
            <button type="button" style={quickLinkStyle()} onClick={() => setSelected(new Set())}>
              None
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {mailboxes.map((mailbox) => (
              <label
                key={mailbox.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 13,
                  color: 'var(--ht-ink)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(mailbox.id)}
                  onChange={() => toggle(mailbox.id)}
                />
                {mailbox.address}
              </label>
            ))}
          </div>

          <div>
            <Button variant="primary" disabled={isPending} onClick={save}>
              Save
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
