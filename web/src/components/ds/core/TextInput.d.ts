export interface TextInputProps {
  value?: string
  onChange?: (e: any) => void
  onKeyDown?: (e: any) => void
  placeholder?: string
  id?: string
  style?: React.CSSProperties
}
export declare function TextInput(props: TextInputProps): JSX.Element
