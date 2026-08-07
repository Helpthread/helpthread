export interface SplitButtonOption {
  label: string;
  icon?: React.ReactNode;
}

/** A primary action with an attached caret. */
export interface SplitButtonProps {
  label?: string;
  /** dropdown options shown when the caret is opened */
  options?: SplitButtonOption[];
  /** "primary" gets the accent fill; anything else renders the bordered treatment */
  variant?: "primary" | "outline";
  /** shows a spinner and "Sending…" in place of the label */
  loading?: boolean;
  disabled?: boolean;
  /** forces a visual state for specimen rendering: hover | focus | active */
  demo?: "hover" | "focus" | "active";
  /** fires for the main button ({ label, primary: true }) and for a chosen option */
  onAction?: (action: SplitButtonOption & { primary?: boolean }) => void;
  /** drops the fixed-position click-away scrim, for embedding inline */
  inline?: boolean;
}
export declare function SplitButton(props: SplitButtonProps): React.JSX.Element;
