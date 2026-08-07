export interface IconButtonProps {
  title: string;
  onClick?: () => void;
  /** lit background (menu open / active) */
  active?: boolean;
  /** "header" = on the accent top bar */
  tone?: "default" | "header";
  size?: number;
  style?: React.CSSProperties;
  /** a solid 13-16px SVG glyph */
  children: React.ReactNode;
}
export declare function IconButton(props: IconButtonProps): React.JSX.Element;
