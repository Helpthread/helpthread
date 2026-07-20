/** The brand's one button. Sentence case labels; destructive actions arm on first press instead of opening a modal. */
export interface ButtonProps {
  /** primary | outline | ghost | destructive */
  variant?: "primary" | "outline" | "ghost" | "destructive";
  /** destructive two-step arm state ("Confirm" fill) */
  armed?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
}
export declare function Button(props: ButtonProps): JSX.Element;
