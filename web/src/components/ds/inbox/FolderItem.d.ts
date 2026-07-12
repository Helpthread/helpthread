export interface FolderItemProps {
  /** solid 13px SVG glyph */
  icon: React.ReactNode
  label: string
  /** empty string hides the count (zero folders show none) */
  count?: string
  active?: boolean
  /** items present = full-ink label; empty = dimmed */
  hasItems?: boolean
  onClick?: () => void
}
export declare function FolderItem(props: FolderItemProps): JSX.Element
