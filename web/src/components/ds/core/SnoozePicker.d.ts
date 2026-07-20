export interface SnoozePickerProps {
  onSnooze?: (when: Date) => void
  inline?: boolean
  initialCustom?: boolean
  initialSel?: Date
}
export declare function SnoozePicker(props: SnoozePickerProps): JSX.Element
