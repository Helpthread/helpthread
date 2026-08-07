export interface MenuItemProps {
  onClick?: () => void;
  icon?: React.ReactNode;
  shortcut?: React.ReactNode;
  selected?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}
export declare function MenuItem(props: MenuItemProps): React.JSX.Element;
