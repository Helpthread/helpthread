export interface CommandMenuItem {
  label: string
  snippet?: string
  keywords?: string
  shortcut?: string
}
export interface CommandMenuProps {
  items?: CommandMenuItem[]
  placeholder?: string
  onPick?: (item: CommandMenuItem) => void
  inline?: boolean
  width?: number
  initialQuery?: string
}
export declare function CommandMenu(props: CommandMenuProps): JSX.Element
