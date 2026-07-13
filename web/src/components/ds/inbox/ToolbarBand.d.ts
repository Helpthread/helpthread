export interface ToolbarBandProps {
  /** accent = over the sheet; panel = over the context panel */
  tone?: 'accent' | 'panel'
  children?: React.ReactNode
  style?: React.CSSProperties
}
export declare function ToolbarBand(props: ToolbarBandProps): JSX.Element
