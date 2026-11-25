import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Workspace } from '../lib/types'
import { workspaceInitials } from '../lib/workspace'
import Icon from './Icon'

interface Props {
  workspaces: Workspace[]
  current: Workspace | null
  onSwitch: (id: string) => void
  onCreate: (name: string) => Promise<void>
  onManage: () => void
  /** opens the list right away (when chosen from the collapsed menu) */
  startOpen?: boolean
}

/** Shows the current workspace and lets the user switch, create one, or go to "Manage workspaces". */
export default function WorkspaceSwitcher({ workspaces, current, onSwitch, onCreate, onManage, startOpen }: Props) {
  const [open, setOpen] = useState(Boolean(startOpen))
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const mine = workspaces.filter((w) => w.isMine)
  const others = workspaces.filter((w) => !w.isMine)

  const close = () => {
    setOpen(false)
    setAdding(false)
    setName('')
    setError(null)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        rootRef.current?.querySelector<HTMLButtonElement>('.ws-current')?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], button')?.focus())
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Give the workspace a name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onCreate(name.trim())
      close()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const item = (w: Workspace) => (
    <button
      key={w.id}
      type="button"
      role="menuitemradio"
      aria-checked={w.id === current?.id}
      className={`ws-item${w.id === current?.id ? ' is-current' : ''}`}
      onClick={() => {
        close()
        if (w.id !== current?.id) onSwitch(w.id)
      }}
    >
      <span className="ws-badge" aria-hidden="true">{workspaceInitials(w.name)}</span>
      <span className="ws-item-text">
        <span className="ws-item-name">{w.name}</span>
        {!w.isMine && w.ownerName && <span className="ws-item-owner">{w.ownerName}</span>}
      </span>
      {w.id === current?.id && <Icon name="check" size={16} />}
    </button>
  )

  return (
    <div className="ws" ref={rootRef}>
      <button
        type="button"
        className="ws-current"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title="Switch workspace"
      >
        <span className="ws-badge" aria-hidden="true">{current ? workspaceInitials(current.name) : '…'}</span>
        <span className="ws-current-text">
          <span className="ws-current-label">Workspace</span>
          <span className="ws-current-name">{current?.name ?? 'Loading…'}</span>
        </span>
        <Icon name="down" size={16} />
      </button>

      {open && (
        <div className="ws-menu" role="menu" aria-label="Workspaces" ref={listRef}>
          <div className="ws-group-title">Your workspaces</div>
          {mine.map(item)}
          {others.length > 0 && (
            <>
              <div className="ws-group-title">Other people's workspaces</div>
              <div className="ws-others">{others.map(item)}</div>
            </>
          )}
          <div className="ws-sep" />
          {adding ? (
            <form className="ws-new" onSubmit={create}>
              <label htmlFor="ws-new-name">New workspace</label>
              <div className="ws-new-row">
                <input
                  id="ws-new-name"
                  className="input"
                  placeholder="e.g. Bata"
                  maxLength={60}
                  value={name}
                  autoFocus
                  onChange={(e) => {
                    setName(e.target.value)
                    setError(null)
                  }}
                />
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
                  {busy ? <span className="spinner" /> : 'Create'}
                </button>
              </div>
              {error && <p className="ws-error" role="alert">{error}</p>}
            </form>
          ) : (
            <button type="button" role="menuitem" className="ws-action" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> New workspace
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="ws-action"
            onClick={() => {
              close()
              onManage()
            }}
          >
            <Icon name="settings" size={16} /> Manage workspaces
          </button>
        </div>
      )}
    </div>
  )
}
