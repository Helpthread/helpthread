export interface ToastProps {
  message: string;
  detail?: string;
  /** position fixed bottom-right */
  fixed?: boolean;
  style?: React.CSSProperties;
}
export declare function Toast(props: ToastProps): JSX.Element;
