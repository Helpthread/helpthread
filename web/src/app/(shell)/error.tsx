'use client'

import { AppError } from '../../components/AppError'

/** Error boundary for the shell (inbox + conversation screens). See `AppError`. */
export default function ShellError(props: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <AppError {...props} />
}
