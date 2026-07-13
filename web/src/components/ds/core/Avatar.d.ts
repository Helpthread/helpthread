export interface AvatarProps {
  /** initials + tone derive from this */
  email?: string
  /** explicit initials override */
  initials?: string
  size?: number
  /** the Agent avatar: accent fill, "S" */
  agent?: boolean
  /** white ring + shadow (threads, context panel) */
  ring?: boolean
  style?: React.CSSProperties
}
export declare function Avatar(props: AvatarProps): JSX.Element
