'use client'

/**
 * `/manage/agents/new` — invite or directly create an Agent (HT-54;
 * specs/auth/agents-and-auth.md §7, §8). Admin-only UI; the engine enforces
 * the mutation itself. FreeScout-modelled: Role, First/Last name (joined
 * into `name` with a single space), Email, and a provisioning choice —
 * "Send an invite email" (default ON) with an admin-set password field that
 * appears only when it's off. No password field when inviting (spec: the
 * two provisioning paths are exclusive). **NEW designed surface — requires
 * TJ fidelity sign-off.**
 *
 * Moved off `/settings/team/new` per TJ's 2026-07-18 admin-IA fidelity
 * review (HT-54) — see `TeamListScreen`'s doc comment.
 *
 * The role picker is a segmented two-button control, the same
 * non-`ds`-component pattern `SettingsScreen`'s Appearance picker already
 * uses (there is no `ds/` Select/Toggle component) — reused, not invented.
 */

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { createAgentAction } from '../lib/agent-actions'
import type { AgentRole } from '../lib/api-types'
import { Button } from './ds/core/Button'
import { TextInput } from './ds/core/TextInput'
import { useToast } from './Toaster'

const MIN_PASSWORD_LENGTH = 8

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  /** Accessible name for the group — a button group can't be named by a `<label htmlFor>` (no form control to reference), so it carries `role="group"` + `aria-label` instead. */
  label: string
}) {
  return (
    <fieldset
      aria-label={label}
      style={{
        display: 'inline-flex',
        margin: 0,
        padding: 0,
        border: '1px solid var(--ht-border)',
        borderRadius: 'var(--ht-radius-md)',
        overflow: 'hidden',
      }}
    >
      {options.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            style={{
              border: 'none',
              padding: '7px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              color: selected ? 'var(--ht-on-accent)' : 'var(--ht-ink-muted)',
              background: selected ? 'var(--ht-accent)' : 'transparent',
            }}
          >
            {option.label}
          </button>
        )
      })}
    </fieldset>
  )
}

function FieldLabel({ children, htmlFor }: { children: string; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--ht-ink-dim)',
        marginBottom: 6,
      }}
    >
      {children}
    </label>
  )
}

export function NewAgentScreen() {
  const router = useRouter()
  const showToast = useToast()
  const [isPending, startTransition] = useTransition()

  const [role, setRole] = useState<AgentRole>('agent')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [sendInvite, setSendInvite] = useState(true)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const name = `${firstName.trim()} ${lastName.trim()}`.trim()
  const canSubmit =
    name.length > 0 &&
    email.trim().length > 0 &&
    (sendInvite || password.length >= MIN_PASSWORD_LENGTH)

  function submit(): void {
    if (isPending || !canSubmit) return
    setError(null)
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof createAgentAction>>
      try {
        result = await createAgentAction({
          name,
          email: email.trim(),
          role,
          sendInvite,
          ...(sendInvite ? {} : { password }),
        })
      } catch {
        // The action invocation itself rejected (network) — surface the same
        // recoverable form error a failed result gets, never an unhandled throw.
        setError('Could not reach the server. Please try again.')
        return
      }
      if (!result.ok) {
        setError(result.message ?? 'Could not create the Agent. Please try again.')
        return
      }
      if (sendInvite && result.inviteSent === false) {
        showToast({
          title: 'Agent created, but the invite email could not be sent',
          detail: 'Resend it from their profile once a mailbox is connected.',
        })
      }
      router.push(
        result.agent !== undefined ? `/manage/agents/${result.agent.id}` : '/manage/agents',
      )
    })
  }

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
      <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <button
          type="button"
          onClick={() => router.push('/manage/agents')}
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'none',
            padding: 0,
            fontSize: 13,
            color: 'var(--ht-ink-muted)',
            cursor: 'pointer',
          }}
        >
          ← Team
        </button>

        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>New Agent</h1>

        <div>
          <FieldLabel>Role</FieldLabel>
          <SegmentedControl
            label="Role"
            options={[
              { value: 'agent', label: 'Agent' },
              { value: 'admin', label: 'Admin' },
            ]}
            value={role}
            onChange={setRole}
          />
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <FieldLabel htmlFor="ht-new-agent-first-name">First name</FieldLabel>
            <TextInput
              id="ht-new-agent-first-name"
              value={firstName}
              onChange={(event: { target: { value: string } }) => setFirstName(event.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <FieldLabel htmlFor="ht-new-agent-last-name">Last name</FieldLabel>
            <TextInput
              id="ht-new-agent-last-name"
              value={lastName}
              onChange={(event: { target: { value: string } }) => setLastName(event.target.value)}
            />
          </div>
        </div>

        <div>
          <FieldLabel htmlFor="ht-new-agent-email">Email</FieldLabel>
          <TextInput
            id="ht-new-agent-email"
            value={email}
            onChange={(event: { target: { value: string } }) => setEmail(event.target.value)}
          />
        </div>

        <div>
          <button
            type="button"
            aria-pressed={sendInvite}
            onClick={() => setSendInvite((current) => !current)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid var(--ht-border)',
              background: 'var(--ht-surface)',
              borderRadius: 'var(--ht-radius-md)',
              padding: '10px 12px',
              cursor: 'pointer',
              width: '100%',
              textAlign: 'left',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 32,
                height: 18,
                borderRadius: 999,
                background: sendInvite ? 'var(--ht-accent)' : 'var(--ht-surface-2)',
                position: 'relative',
                flexShrink: 0,
                transition: 'background 0.15s',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: sendInvite ? 16 : 2,
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: 'var(--ht-surface)',
                  transition: 'left 0.15s',
                }}
              />
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ht-ink)' }}>
              Send an invite email
            </span>
          </button>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ht-ink-dim)' }}>
            An invite can be sent later.
          </p>
        </div>

        {!sendInvite && (
          <div>
            <FieldLabel htmlFor="ht-new-agent-password">Password</FieldLabel>
            <input
              id="ht-new-agent-password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                fontFamily: 'var(--ht-sans)',
                fontSize: 12.5,
                color: 'var(--ht-ink)',
                background: 'var(--ht-bg)',
                border: '1px solid var(--ht-divider)',
                borderRadius: 'var(--ht-radius-sm)',
                padding: '6px 10px',
                outline: 'none',
              }}
            />
            <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--ht-ink-dim)' }}>
              At least {MIN_PASSWORD_LENGTH} characters. Share it with the Agent yourself.
            </p>
          </div>
        )}

        {error !== null && (
          <div
            role="alert"
            aria-live="assertive"
            style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ht-critical)' }}
          >
            {error}
          </div>
        )}

        <div>
          <Button variant="primary" disabled={isPending || !canSubmit} onClick={submit}>
            {isPending ? 'Creating…' : 'Create Agent'}
          </Button>
        </div>
      </div>
    </main>
  )
}
