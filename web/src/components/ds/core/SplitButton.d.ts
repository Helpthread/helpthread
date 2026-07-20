export interface SplitButtonOption {
  label: string
  icon?: React.ReactNode
}
export interface SplitButtonProps {
  label?: string
  options?: SplitButtonOption[]
  variant?: 'primary' | 'outline'
  loading?: boolean
  disabled?: boolean
  /** Forces a visual state for specimen rendering. */
  demo?: 'hover' | 'focus' | 'active'
  onAction?: (option: SplitButtonOption & { primary?: boolean }) => void
  /** Skip the click-outside overlay (for inline/specimen rendering). */
  inline?: boolean
}
export declare function SplitButton(props: SplitButtonProps): JSX.Element
