/** One inbox table row; compose under a 48px header band. */
export interface ConversationRowProps {
  customerName: string;
  customerEmail: string;
  subject: string;
  /** excerpt of the latest message */
  preview?: string;
  /** thread count; empty hides the pill but keeps its column slot */
  count?: string;
  /** human conversation number (#N) */
  number?: string;
  /** relative waiting time */
  time?: string;
  starred?: boolean;
  onStar?: () => void;
  checked?: boolean;
  onCheck?: (e: any) => void;
  showCheckbox?: boolean;
  /** j/k keyboard cursor state */
  selected?: boolean;
  onClick?: () => void;
}
export declare function ConversationRow(props: ConversationRowProps): JSX.Element;
