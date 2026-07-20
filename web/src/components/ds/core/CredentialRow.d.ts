export interface Credential {
  name: string
  added: Date
  lastUsed?: Date | null
}
export interface CredentialRowProps {
  cred: Credential
  /** Forces a visual state for specimen rendering. */
  demo?: 'hover' | 'rename' | 'armed'
  onRename?: (cred: Credential, name: string) => void
  onRevoke?: (cred: Credential) => void
  first?: boolean
}
export declare function CredentialRow(props: CredentialRowProps): JSX.Element

export interface PasskeyListProps {
  creds?: Credential[]
  empty?: boolean
  onAdd?: () => void
}
export declare function PasskeyList(props: PasskeyListProps): JSX.Element
