/**
 * Barrel for the platform provider interfaces (see `src/providers/README.md`).
 * Engine modules import provider types from here — never from an individual
 * provider file directly, and never from a platform SDK.
 */

export type {
  EnqueueOptions,
  QueueMessage,
  QueueHandlerResult,
  QueueMessageHandler,
  QueueProvider,
} from "./queue";

export type { HandlerRef, SchedulerProvider } from "./scheduler";

export type { BlobStore } from "./blob";

export type {
  NormalizedInboundAttachment,
  NormalizedInboundEmail,
  InboundEmailProvider,
} from "./inbound-email";
