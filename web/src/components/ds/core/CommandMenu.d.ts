export interface CommandMenuItem {
  label: string;
  /** shown under the label, and matched against the query */
  snippet?: string;
  /** extra text matched against the query but not shown in the row */
  keywords?: string;
  shortcut?: React.ReactNode;
}

/** Searchable inserter for saved replies. */
export interface CommandMenuProps {
  items?: CommandMenuItem[];
  placeholder?: string;
  onPick?: (item: CommandMenuItem) => void;
  /** drops the rise-in animation and autofocus, for embedding inline */
  inline?: boolean;
  width?: number;
  initialQuery?: string;
}
export declare function CommandMenu(props: CommandMenuProps): JSX.Element;
