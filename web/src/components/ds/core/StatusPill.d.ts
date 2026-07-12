export interface StatusPillProps {
  /** active | pending | closed | spam | note (unknown = neutral) */
  status: string
  /** override the derived label */
  label?: string
  style?: React.CSSProperties
}
export declare function StatusPill(props: StatusPillProps): JSX.Element
