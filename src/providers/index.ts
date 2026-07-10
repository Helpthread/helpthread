/**
 * Barrel for the platform provider interfaces (see `src/providers/README.md`).
 * Engine modules import provider types from here — never from an individual
 * provider file directly, and never from a platform SDK.
 */

export type { BlobStore } from './blob.js'
export type { EmailSender, EmailSendResult, OutboundEmail } from './email-sender.js'
export type {
  InboundEmailProvider,
  NormalizedInboundAttachment,
  NormalizedInboundEmail,
} from './inbound-email.js'
export type {
  EnqueueOptions,
  QueueHandlerResult,
  QueueMessage,
  QueueMessageHandler,
  QueueProvider,
} from './queue.js'
export type { HandlerRef, SchedulerProvider } from './scheduler.js'
