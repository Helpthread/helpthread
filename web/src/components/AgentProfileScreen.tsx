'use client'

/**
 * `/manage/agents/{id}` — an Agent's profile (HT-54; specs/auth/agents-and-
 * auth.md §7): admin for anyone, self for their own. FreeScout-modelled:
 * name, email (read-only, immutable in v1 — spec §3.2), timezone, role
 * (admin-only control), a Disabled toggle (admin-only, hidden on self —
 * you can't lock yourself out from here), a Change-password subform (self,
 * or admin reset), Save, and — admin viewing someone else — Delete with the
 * two-step arm pattern (`ConversationScreen`'s delete: press → solid
 * critical Confirm → auto-disarm; never `confirm()`). Resend Invite appears
 * only while `status === 'invited'`. **NEW designed surface — requires TJ
 * fidelity sign-off.**
 *
 * Renders as the content pane inside `AgentDetailShell` (the "Profile"
 * section) — moved off `/settings/team/{id}` to `/manage/agents/{id}` and
 * off a bare "← Team" link onto the shell's sidebar, per TJ's 2026-07-18
 * admin-IA fidelity review (HT-54): Team management is `Manage ▾`-scoped,
 * not nested under Settings.
 */

import { useRouter } from 'next/navigation'
import type { CSSProperties } from 'react'
import { useRef, useState, useTransition } from 'react'
import {
  type AgentActionResult,
  deleteAgentAction,
  patchAgentAction,
  resendInviteAction,
  setAgentPasswordAction,
} from '../lib/agent-actions'
import type { Agent, AgentRole, SelfAgent } from '../lib/api-types'
import { initialsFromName } from '../lib/format'
import { Avatar } from './ds/core/Avatar'
import { Button } from './ds/core/Button'
import { StatusPill } from './ds/core/StatusPill'
import { useToast } from './Toaster'

const DELETE_DISARM_MS = 3500
const MIN_PASSWORD_LENGTH = 8

/**
 * Await a server-action invocation, normalizing a REJECTED invocation (the
 * client→server request itself failing — network, aborted navigation) into
 * the same `{ ok: false }` shape a failed result carries, so every flow
 * below has exactly one failure path and none can escape as an unhandled
 * rejection inside `startTransition`.
 */
async function invokeAction(invocation: Promise<AgentActionResult>): Promise<AgentActionResult> {
  try {
    return await invocation
  } catch {
    return { ok: false, message: 'Could not reach the server. Please try again.' }
  }
}

// 'UTC' is prepended because Intl.supportedValuesOf('timeZone') does NOT
// include it (verified live: 418 IANA zones, none of them plain UTC) — yet
// it is the engine's schema default, so without it the <select> would fall
// back to its first option (Africa/Abidjan) and a Save would silently
// rewrite a UTC Agent's timezone.
const TIMEZONES: readonly string[] = [
  'UTC',
  ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []),
]

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

function textFieldStyle(): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: 'var(--ht-sans)',
    fontSize: 12.5,
    color: 'var(--ht-ink)',
    background: 'var(--ht-bg)',
    border: '1px solid var(--ht-divider)',
    borderRadius: 'var(--ht-radius-sm)',
    padding: '7px 10px',
    outline: 'none',
  }
}

export function AgentProfileScreen({
  agent,
  viewer,
}: {
  agent: Agent
  /** The signed-in Agent (`getMe()`) — determines self vs. admin-on-another. */
  viewer: SelfAgent
}) {
  const router = useRouter()
  const showToast = useToast()
  const [isPending, startTransition] = useTransition()

  const isSelf = viewer.id === agent.id
  const isAdmin = viewer.role === 'admin'
  const canEdit = isSelf || isAdmin

  const [name, setName] = useState(agent.name)
  const [timezone, setTimezone] = useState(agent.timezone)
  const [role, setRole] = useState<AgentRole>(agent.role)
  const [disabled, setDisabled] = useState(agent.status === 'disabled')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const [deleteArmed, setDeleteArmed] = useState(false)
  const deleteDisarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword
  const canChangePassword = (isSelf || isAdmin) && agent.status !== 'invited'
  const canSetPassword = password.length >= MIN_PASSWORD_LENGTH && password === confirmPassword

  function saveProfile(): void {
    if (isPending || !canEdit) return
    setError(null)
    startTransition(async () => {
      // Never name `status` on an `invited` Agent: the engine's closed
      // lifecycle 409s ANY status mention there (spec §6), which would turn
      // every admin Save on a pending invite — even a name fix — into a
      // dead-end conflict. `invited` exits only via invite acceptance.
      const status: 'active' | 'disabled' = disabled ? 'disabled' : 'active'
      const patch = isAdmin
        ? agent.status === 'invited'
          ? { name, timezone, role }
          : { name, timezone, role, status }
        : { name, timezone }
      const result = await invokeAction(patchAgentAction(agent.id, patch))
      if (!result.ok) {
        if (result.code === 'conflict') {
          showToast({ title: "Couldn't save", detail: result.message })
        } else {
          setError(result.message ?? 'Could not save. Please try again.')
        }
        return
      }
      showToast({ title: 'Profile saved' })
      router.refresh()
    })
  }

  function submitPasswordChange(): void {
    if (isPending || !canSetPassword) return
    setPasswordError(null)
    startTransition(async () => {
      const result = await invokeAction(setAgentPasswordAction(agent.id, password))
      if (!result.ok) {
        setPasswordError(result.message ?? 'Could not change the password. Please try again.')
        return
      }
      setPassword('')
      setConfirmPassword('')
      showToast({ title: 'Password updated' })
    })
  }

  function resendInvite(): void {
    startTransition(async () => {
      const result = await invokeAction(resendInviteAction(agent.id))
      if (!result.ok) {
        showToast({ title: "Couldn't resend the invite", detail: result.message })
        return
      }
      showToast({ title: 'Invite resent' })
    })
  }

  function onDeleteClick(): void {
    if (!deleteArmed) {
      setDeleteArmed(true)
      deleteDisarmTimer.current = setTimeout(() => setDeleteArmed(false), DELETE_DISARM_MS)
      return
    }
    if (deleteDisarmTimer.current !== null) clearTimeout(deleteDisarmTimer.current)
    setDeleteArmed(false)
    startTransition(async () => {
      const result = await invokeAction(deleteAgentAction(agent.id))
      if (!result.ok) {
        showToast({ title: "Couldn't delete this Agent", detail: result.message })
        return
      }
      showToast({ title: 'Agent deleted' })
      router.push('/manage/agents')
    })
  }

  return (
    <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Avatar email={agent.email} initials={initialsFromName(agent.name)} size={40} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{agent.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--ht-ink-dim)' }}>{agent.email}</div>
        </div>
        <span style={{ flex: 1 }} />
        {agent.status === 'invited' && <StatusPill status="pending" label="Invited" />}
        {agent.status === 'disabled' && <StatusPill status="closed" label="Disabled" />}
      </div>

      <div>
        <FieldLabel htmlFor="ht-agent-name">Name</FieldLabel>
        <input
          id="ht-agent-name"
          value={name}
          disabled={!canEdit}
          onChange={(event) => setName(event.target.value)}
          style={textFieldStyle()}
        />
      </div>

      <div>
        <FieldLabel>Email</FieldLabel>
        <div
          style={{
            ...textFieldStyle(),
            color: 'var(--ht-ink-dim)',
            background: 'var(--ht-surface-2)',
          }}
        >
          {agent.email}
        </div>
      </div>

      <div>
        <FieldLabel htmlFor="ht-agent-timezone">Timezone</FieldLabel>
        {/* Native <select>, not a ds/ component — the design system has no
              Select primitive (same "genuine gap" rationale as LoginScreen's
              documented workarounds). */}
        <select
          id="ht-agent-timezone"
          value={timezone}
          disabled={!canEdit}
          onChange={(event) => setTimezone(event.target.value)}
          style={textFieldStyle()}
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      {isAdmin && (
        <div>
          <FieldLabel>Role</FieldLabel>
          <fieldset
            aria-label="Role"
            style={{
              display: 'inline-flex',
              margin: 0,
              padding: 0,
              border: '1px solid var(--ht-border)',
              borderRadius: 'var(--ht-radius-md)',
              overflow: 'hidden',
            }}
          >
            {(['agent', 'admin'] as const).map((option) => {
              const selected = role === option
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setRole(option)}
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
                  {option === 'admin' ? 'Admin' : 'Agent'}
                </button>
              )
            })}
          </fieldset>
        </div>
      )}

      {isAdmin && !isSelf && agent.status !== 'invited' && (
        <button
          type="button"
          aria-pressed={disabled}
          onClick={() => setDisabled((current) => !current)}
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
              background: disabled ? 'var(--ht-critical)' : 'var(--ht-surface-2)',
              position: 'relative',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: disabled ? 16 : 2,
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: 'var(--ht-surface)',
              }}
            />
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ht-ink)' }}>
            Disabled — prevent this Agent from signing in
          </span>
        </button>
      )}

      {agent.status === 'invited' && isAdmin && (
        <Button variant="outline" onClick={resendInvite} disabled={isPending}>
          Resend invite
        </Button>
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

      {canEdit && (
        <div>
          <Button variant="primary" disabled={isPending} onClick={saveProfile}>
            Save
          </Button>
        </div>
      )}

      {canChangePassword && (
        <section
          style={{
            borderTop: '1px solid var(--ht-divider)',
            paddingTop: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            {isSelf ? 'Change password' : "Reset this Agent's password"}
          </div>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={textFieldStyle()}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            style={textFieldStyle()}
          />
          {passwordMismatch && (
            <div style={{ fontSize: 12, color: 'var(--ht-critical)' }}>Passwords don't match.</div>
          )}
          {passwordError !== null && (
            <div
              role="alert"
              aria-live="assertive"
              style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ht-critical)' }}
            >
              {passwordError}
            </div>
          )}
          <div>
            <Button
              variant="outline"
              disabled={isPending || !canSetPassword}
              onClick={submitPasswordChange}
            >
              Update password
            </Button>
          </div>
        </section>
      )}

      {isAdmin && !isSelf && (
        <section
          style={{
            borderTop: '1px solid var(--ht-divider)',
            paddingTop: 16,
          }}
        >
          {deleteArmed ? (
            <Button variant="destructive" armed onClick={onDeleteClick}>
              Click again to permanently delete
            </Button>
          ) : (
            <Button variant="destructive" onClick={onDeleteClick}>
              Delete Agent
            </Button>
          )}
        </section>
      )}
    </div>
  )
}
