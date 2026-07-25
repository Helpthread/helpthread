/**
 * The mailbox-settings section registry (HT-101; specs/ui/admin-ia.md §1's
 * mailbox-scoped row + §3 Rule 2: "Manage entries, mailbox-settings entries,
 * and Settings sections are all injection points a module can extend. Core
 * surfaces must not assume a closed menu.")
 *
 * `InboxSettingsShell` (`../components/InboxSettingsShell.tsx`) and the
 * folder rail's gear menu (`../components/FolderNav.tsx`) both render this
 * list — NEITHER hardcodes the section menu as inline JSX. A hardcoded
 * mailbox-settings menu is a spec violation under Rule 2, the exact defect
 * this module exists to prevent: today `resolveInboxSettingsSections`
 * returns only the core entries below, but the shape is built so a future
 * module can splice its own entries into the same list without either
 * consumer changing.
 *
 * Section order matches admin-ia.md §1's mailbox-scoped row: Edit Mailbox
 * (**General** here — the engine has no per-inbox name/signature/alias
 * fields yet, so it ships `planned`), Connection Settings (**Connection** —
 * the only `available` entry this pass), Permissions, Auto Reply, then the
 * three free-core-per-catalog surfaces (specs/modules/catalog.md §2.2):
 * Custom Folders, Saved Replies, Satisfaction Ratings.
 */

export interface InboxSettingsSection {
  /** Stable identifier — also the `[section]` route param (`app/mailbox/[id]/settings/[section]/page.tsx`). */
  key: string
  label: string
  href: (mailboxId: string) => string
  /** `planned` renders visibly disabled ("Not yet available") — an honest menu, never a fake link (admin-ia.md Rule 6). */
  status: 'available' | 'planned'
  /** `'core'` for the entries below; a future module entry carries `{ module: '<module-id>' }` instead. */
  source: 'core' | { module: string }
}

function sectionHref(mailboxId: string, key: string): string {
  return `/mailbox/${mailboxId}/settings/${key}`
}

export const CORE_INBOX_SETTINGS_SECTIONS: InboxSettingsSection[] = [
  {
    key: 'general',
    label: 'General',
    href: (mailboxId) => sectionHref(mailboxId, 'general'),
    status: 'planned',
    source: 'core',
  },
  {
    key: 'connection',
    label: 'Connection',
    href: (mailboxId) => sectionHref(mailboxId, 'connection'),
    status: 'available',
    source: 'core',
  },
  {
    key: 'permissions',
    label: 'Permissions',
    href: (mailboxId) => sectionHref(mailboxId, 'permissions'),
    status: 'planned',
    source: 'core',
  },
  {
    key: 'auto-reply',
    label: 'Auto Reply',
    href: (mailboxId) => sectionHref(mailboxId, 'auto-reply'),
    status: 'planned',
    source: 'core',
  },
  {
    key: 'custom-folders',
    label: 'Custom Folders',
    href: (mailboxId) => sectionHref(mailboxId, 'custom-folders'),
    status: 'planned',
    source: 'core',
  },
  {
    key: 'saved-replies',
    label: 'Saved Replies',
    href: (mailboxId) => sectionHref(mailboxId, 'saved-replies'),
    status: 'planned',
    source: 'core',
  },
  {
    key: 'satisfaction-ratings',
    label: 'Satisfaction Ratings',
    href: (mailboxId) => sectionHref(mailboxId, 'satisfaction-ratings'),
    status: 'planned',
    source: 'core',
  },
]

/**
 * Resolves core + installed-module entries, in display order. Modules will
 * contribute here once the in-process module API exists
 * (specs/modules/catalog.md §1's "build-time module API" — not built yet);
 * today this returns core only. Callers (`InboxSettingsShell`, the folder
 * rail's gear menu) must call this rather than importing
 * `CORE_INBOX_SETTINGS_SECTIONS` directly, so a module's entries appear
 * everywhere the core list does the moment that resolution is wired in.
 */
export function resolveInboxSettingsSections(): InboxSettingsSection[] {
  return CORE_INBOX_SETTINGS_SECTIONS
}
