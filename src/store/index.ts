/**
 * Barrel for the store layer (`src/store/**`) — persistence built on the
 * raw-SQL seam in `src/db/**`. See `src/store/conversations.ts` for the
 * `ConversationStore` contract and the storage-layer policy it implements,
 * and `src/store/inbound-deliveries.ts` for the `InboundDeliveryStore`
 * (inbound delivery ledger) contract.
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
export {
  appendThreadInTx,
  createConversationInTx,
  createConversationStore,
} from './conversations.js'
export type {
  ClaimResult,
  InboundDeliveryStatus,
  InboundDeliveryStore,
  StoredInboundDelivery,
} from './inbound-deliveries.js'
export { createInboundDeliveryStore, markStoredInTx } from './inbound-deliveries.js'
