export interface MessageBandProps {
  /** inbound (customer) | outbound (Agent reply) | note (internal) */
  kind?: 'inbound' | 'outbound' | 'note'
  fromLabel: string
  fromAddr?: string
  time?: string
  /** outbound only: "sent" | "pending" */
  delivery?: string
  /** read receipt time — renders the eye line */
  viewedAt?: string
  /** loud failed-delivery banner */
  failed?: boolean
  /** hairline top within same-speaker runs */
  sameSpeakerAsPrev?: boolean
  /** drives the avatar tone */
  email?: string
  children: React.ReactNode
}
export declare function MessageBand(props: MessageBandProps): JSX.Element
