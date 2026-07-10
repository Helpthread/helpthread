/**
 * Barrel for the store layer (`src/store/**`) — persistence built on the
 * raw-SQL seam in `src/db/**`. See `src/store/conversations.ts` for the
 * `ConversationStore` contract and the storage-layer policy it implements.
 */

export type {
  AppendResult,
  ConversationListCursor,
  ConversationStore,
  ConversationSummary,
  ListConversationsOptions,
  NewConversation,
  NewThread,
  StoredConversation,
  StoredThread,
} from './conversations.js'
export { createConversationStore } from './conversations.js'
