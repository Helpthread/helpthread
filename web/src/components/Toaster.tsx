'use client'

/**
 * Toast stack, bottom-right. The DS `Toast` (`ds/core/Toast`) only knows
 * how to render ONE toast (optionally self-fixed); this provider owns the
 * stack, the fixed container, and the auto-dismiss timer, rendering each
 * entry with `fixed` off so multiple can stack in our own container.
 */

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { Toast } from './ds/core/Toast'

export interface ShowToastInput {
  title: string
  detail?: string
}

interface ToastEntry extends ShowToastInput {
  id: number
}

const AUTO_DISMISS_MS = 4200

const ToastContext = createContext<((input: ShowToastInput) => void) | null>(null)

export function ToasterProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const nextId = useRef(0)

  const showToast = useCallback(({ title, detail }: ShowToastInput) => {
    const id = nextId.current++
    setToasts((current) => [...current, { id, title, detail }])
    setTimeout(() => {
      setToasts((current) => current.filter((entry) => entry.id !== id))
    }, AUTO_DISMISS_MS)
  }, [])

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div
        style={{
          position: 'fixed',
          right: 20,
          bottom: 20,
          zIndex: 70,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
        }}
      >
        {toasts.map((toast) => (
          <Toast key={toast.id} message={toast.title} detail={toast.detail} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/** `const showToast = useToast(); showToast({ title, detail? })`. */
export function useToast(): (input: ShowToastInput) => void {
  const ctx = useContext(ToastContext)
  if (ctx === null) throw new Error('useToast must be used within ToasterProvider')
  return ctx
}
