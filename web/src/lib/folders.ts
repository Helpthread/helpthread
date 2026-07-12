/**
 * The UI's seven-folder taxonomy — a view over the API's three-folder
 * `ConversationStatus`/`ConversationFolder` model (`api-types.ts`), not a
 * wire concept of its own. Unassigned/Mine/Assigned are derived client- and
 * server-side from `open` conversations' `assignee`; Starred/Drafts are
 * derived from localStorage. Shared by the folder rail, the dashboard's
 * mailbox card, and the inbox list screen so the labels/icons/empty-copy
 * live in exactly one place.
 */

export type AppFolder =
  | 'unassigned'
  | 'mine'
  | 'starred'
  | 'drafts'
  | 'assigned'
  | 'closed'
  | 'spam'

export const FOLDER_ORDER: readonly AppFolder[] = [
  'unassigned',
  'mine',
  'starred',
  'drafts',
  'assigned',
  'closed',
  'spam',
]

export function isAppFolder(value: string): value is AppFolder {
  return (FOLDER_ORDER as readonly string[]).includes(value)
}

export const FOLDER_LABELS: Record<AppFolder, string> = {
  unassigned: 'Unassigned',
  mine: 'Mine',
  starred: 'Starred',
  drafts: 'Drafts',
  assigned: 'Assigned',
  closed: 'Closed',
  spam: 'Spam',
}

/** Solid 24x24 glyph paths (Material-style), one per folder. */
export const FOLDER_ICON_PATHS: Record<AppFolder, string> = {
  unassigned:
    'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  mine: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  starred:
    'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  drafts:
    'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.42l-2.34-2.34a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z',
  assigned:
    'M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zM8 11c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05C16.16 13.87 17 15 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  closed:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  spam: 'M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z',
}

export const EMPTY_COPY: Record<AppFolder, { title: string; body: string; celebrate: boolean }> = {
  unassigned: {
    title: 'Inbox zero.',
    body: 'Every customer has an answer. New email lands here the moment it arrives.',
    celebrate: true,
  },
  mine: {
    title: 'Nothing assigned to you',
    body: 'Conversations you take with the assignee control land here.',
    celebrate: false,
  },
  assigned: {
    title: 'Nothing assigned',
    body: 'Assigned conversations land here.',
    celebrate: false,
  },
  starred: {
    title: 'No starred conversations',
    body: 'Star a conversation from its page to pin it here for quick return.',
    celebrate: false,
  },
  drafts: {
    title: 'No drafts',
    body: "Replies you start writing but don't send wait here until you're ready.",
    celebrate: false,
  },
  closed: {
    title: 'Nothing closed yet',
    body: 'Conversations you close move here. Replying to one reopens it.',
    celebrate: false,
  },
  spam: {
    title: 'No spam',
    body: 'Conversations you mark as spam move here, out of your way.',
    celebrate: false,
  },
}

/** Server-derived counts for the five API-backed folders (spec §3a lists have no totals). */
export interface ServerFolderCounts {
  unassigned: string
  mine: string
  assigned: string
  closed: string
  spam: string
}

/** Merge the server counts with the two localStorage-only folders' live counts. */
export function mergeFolderCounts(
  server: ServerFolderCounts,
  local: { starred: number; drafts: number },
): Record<AppFolder, string> {
  return {
    unassigned: server.unassigned,
    mine: server.mine,
    starred: local.starred > 0 ? String(local.starred) : '',
    drafts: local.drafts > 0 ? String(local.drafts) : '',
    assigned: server.assigned,
    closed: server.closed,
    spam: server.spam,
  }
}
