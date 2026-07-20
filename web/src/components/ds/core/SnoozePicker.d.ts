/** Choose a wake time: quick presets or a custom calendar + time. */
export interface SnoozePickerProps {
  /** fires with the resolved Date, from either a preset or the custom picker */
  onSnooze?: (when: Date) => void;
  /** drops the rise-in animation, for embedding inline */
  inline?: boolean;
  /** opens directly into the custom calendar + time view */
  initialCustom?: boolean;
  /** seed date for the custom calendar */
  initialSel?: Date;
}
export declare function SnoozePicker(props: SnoozePickerProps): JSX.Element;
