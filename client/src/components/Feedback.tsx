import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { FeedbackContext, type Confirm, type ConfirmOptions, type Notify } from '../lib/feedback'

/** App-wide confirmation dialog and short status messages (no browser alert/confirm). */

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null)
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const ref = useRef<HTMLDialogElement>(null)

  const confirm = useCallback<Confirm>((options) => new Promise((resolve) => setDialog({ ...options, resolve })), [])
  const notify = useCallback<Notify>((message) => setToast({ id: Date.now(), message }), [])

  useEffect(() => {
    if (dialog && ref.current && !ref.current.open) ref.current.showModal()
  }, [dialog])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  function close(ok: boolean) {
    dialog?.resolve(ok)
    ref.current?.close()
    setDialog(null)
  }

  return (
    <FeedbackContext.Provider value={{ confirm, notify }}>
      {children}
      {dialog && (
        <dialog ref={ref} className="dialog" onCancel={(e) => { e.preventDefault(); close(false) }}>
          <h2>{dialog.title}</h2>
          {dialog.body && <p>{dialog.body}</p>}
          <div className="dialog-actions">
            <button className="btn" onClick={() => close(false)} autoFocus>
              {dialog.cancelLabel ?? 'Cancel'}
            </button>
            <button className={dialog.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => close(true)}>
              {dialog.confirmLabel}
            </button>
          </div>
        </dialog>
      )}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && <div key={toast.id} className="toast">{toast.message}</div>}
      </div>
    </FeedbackContext.Provider>
  )
}
