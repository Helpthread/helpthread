export interface Credential {
  name: string;
  added: Date;
  lastUsed?: Date | null;
}

/** A registered passkey: key icon, name, added / last-used metadata, inline
 *  rename, and revoke behind a two-step arm. */
export interface CredentialRowProps {
  cred: Credential;
  /** forces a visual state for specimen rendering: hover | rename | armed */
  demo?: "hover" | "rename" | "armed";
  onRename?: (cred: Credential, name: string) => void;
  onRevoke?: (cred: Credential) => void;
  /** true for the first row in the list; suppresses the top divider */
  first?: boolean;
}
export declare function CredentialRow(props: CredentialRowProps): React.JSX.Element;

/** The passkey list: registered credentials plus the add affordance, or the
 *  empty state when nothing is registered yet. */
export interface PasskeyListProps {
  creds?: Credential[];
  /** forces the empty state even when creds is non-empty */
  empty?: boolean;
  onAdd?: () => void;
}
export declare function PasskeyList(props: PasskeyListProps): React.JSX.Element;
