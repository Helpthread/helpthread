'use client'

import { AppError } from '../../components/AppError'

/** Error boundary for /settings. See `AppError`. */
export default function SettingsError(props: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return <AppError {...props} />
}
