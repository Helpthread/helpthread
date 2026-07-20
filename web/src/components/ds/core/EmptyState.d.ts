export interface EmptyStateProps {
  title: string;
  body?: string;
  /** italic celebration ("Inbox zero.") */
  celebrate?: boolean;
}
export declare function EmptyState(props: EmptyStateProps): React.JSX.Element;
