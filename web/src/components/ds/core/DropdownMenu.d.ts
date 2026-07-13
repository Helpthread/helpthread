export interface DropdownMenuProps {
  open: boolean
  onClose: () => void
  align?: 'left' | 'right'
  top?: number
  minWidth?: number
  children: React.ReactNode
}
export declare function DropdownMenu(props: DropdownMenuProps): JSX.Element
