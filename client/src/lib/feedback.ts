import { createContext, useContext } from 'react'

export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
}
export type Confirm = (options: ConfirmOptions) => Promise<boolean>
export type Notify = (message: string) => void

export const FeedbackContext = createContext<{ confirm: Confirm; notify: Notify } | null>(null)

/** confirm(): in-app confirmation dialog. notify(): short status message. */
export function useFeedback() {
  const ctx = useContext(FeedbackContext)
  if (!ctx) throw new Error('FeedbackProvider is missing')
  return ctx
}
