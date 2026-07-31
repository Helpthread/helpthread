import type { ReactNode } from 'react'
import { FolderNav } from '../../components/FolderNav'
import { ApiError, getMe, listMailboxes } from '../../lib/api'
import { loadFolderCounts } from '../../lib/folder-counts'

/**
 * The gear menu's mailbox list, or `[]` if the engine could not supply it.
 * See the call site for why this failure is contained and why a 401 is not.
 */
async function listMailboxesForGear(): Promise<Awaited<ReturnType<typeof listMailboxes>>> {
  try {
    return await listMailboxes()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw err
    }
    console.error('[shell] could not load mailboxes for the gear menu', err)
    return []
  }
}

/**
 * The app shell shared by the inbox and conversation routes: the persistent
 * folder rail on the warm-paper canvas, with each screen as the elevated
 * work surface beside it (the design system's layer model). The rail's
 * counts and support address are fetched here (server-side, with the
 * Bearer token) and handed to the client `FolderNav` as props. `getMe()`
 * resolves "Mine" (HT-54: a real Agent id, not the old `'me'` sentinel) — a
 * 401 here (a stale/disabled Agent's still-valid cookie) propagates to the
 * nearest error boundary ABOVE this segment (`app/error.tsx` — a segment's
 * own `error.tsx` never catches its own layout's errors), which routes the
 * SESSION_ERROR digest to a re-login redirect, exactly as intended.
 *
 * `mailbox` (HT-101 admin-IA correction) resolves THIS deployment's mailbox
 * for `FolderNav`'s gear menu: match `HELPTHREAD_SUPPORT_ADDRESS`, falling
 * back to the first connected mailbox — same "one primary inbox, several
 * connected mailboxes" posture `supportAddress` below already assumes.
 * `GET /api/v1/mailboxes` is admin-only (`handleListMailboxes`,
 * `src/api/agents.ts` — 403 for a non-admin caller), same gate the
 * mailbox-settings routes themselves enforce (`app/mailbox/[id]/settings/
 * [section]/page.tsx`), so it's only fetched for an admin viewer — a
 * non-admin gets `mailbox: null` and an inert gear, never a 403.
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const me = await getMe()
  const counts = await loadFolderCounts(me.id)
  const supportAddress = process.env.HELPTHREAD_SUPPORT_ADDRESS ?? 'support@dev.localhost'

  // The mailbox list feeds ONE affordance — the gear menu — but this layout
  // wraps the entire inbox and conversation surface. An engine error here used
  // to propagate to the error boundary and take the folder rail, the counts,
  // and the conversation view with it (review, 2026-07-25): the whole app lost
  // to a decoration. Degrade to an inert gear instead, which `FolderNav`
  // already supports via `mailbox: null`.
  //
  // A 401 is deliberately NOT contained. That means a stale or disabled
  // Agent's cookie, and it must keep propagating so the SESSION_ERROR digest
  // reaches `app/error.tsx` and routes to re-login (module doc above).
  // Swallowing it would strand the viewer in a shell they can no longer use.
  const mailboxes = me.role === 'admin' ? await listMailboxesForGear() : []
  // Case-insensitive: `HELPTHREAD_SUPPORT_ADDRESS` is operator-supplied free
  // text and the stored address comes from the connect form, so a case
  // difference in either would silently fall through to `mailboxes[0]` and
  // deep-link the gear into a DIFFERENT mailbox than the rail displays.
  const wanted = supportAddress.toLowerCase()
  const resolvedMailbox =
    mailboxes.find((entry) => entry.address.toLowerCase() === wanted) ?? mailboxes[0]
  const mailbox =
    resolvedMailbox !== undefined
      ? { id: resolvedMailbox.id, address: resolvedMailbox.address }
      : null

  return (
    <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
      <FolderNav supportAddress={supportAddress} counts={counts} mailbox={mailbox} />
      {children}
    </div>
  )
}
