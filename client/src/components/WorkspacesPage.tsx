import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Workspace } from '../lib/types'
import { useFeedback } from '../lib/feedback'
import { fullDate } from '../lib/format'
import { workspaceInitials } from '../lib/workspace'
import Icon from './Icon'

interface Props {
  workspaces: Workspace[]
  currentId: string | null
  isAdmin: boolean
  onOpen: (id: string) => void
  onCreate: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

/** Your workspaces: create, rename, delete, open. Admins also see other people's workspaces. */
export default function WorkspacesPage({ workspaces, currentId, isAdmin, onOpen, onCreate, onRename, onDelete }: Props) {
  const { confirm, notify } = useFeedback()
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const mine = workspaces.filter((w) => w.isMine)
  const others = workspaces.filter((w) => !w.isMine)

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!newName.trim()) {
      setCreateError('Give the workspace a name.')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await onCreate(newName.trim())
      notify(`Workspace “${newName.trim()}” created`)
      setNewName('')
    } catch (err) {
      setCreateError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  async function saveName(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    if (!editing.name.trim()) {
      setRowError({ id: editing.id, message: 'Give the workspace a name.' })
      return
    }
    setBusyId(editing.id)
    try {
      await onRename(editing.id, editing.name.trim())
      setEditing(null)
      setRowError(null)
      notify('Workspace renamed')
    } catch (err) {
      setRowError({ id: editing.id, message: (err as Error).message })
    } finally {
      setBusyId(null)
    }
  }

  async function remove(w: Workspace) {
    const ok = await confirm({
      title: `Delete “${w.name}”?`,
      body: 'Its modules, forms and run history will no longer be shown to anyone. This cannot be undone in the app.',
      confirmLabel: 'Delete workspace',
      danger: true,
    })
    if (!ok) return
    setBusyId(w.id)
    try {
      await onDelete(w.id)
      notify(`Workspace “${w.name}” deleted`)
    } catch (err) {
      setRowError({ id: w.id, message: (err as Error).message })
    } finally {
      setBusyId(null)
    }
  }

  const row = (w: Workspace) => {
    const isEditing = editing?.id === w.id
    return (
      <tr key={w.id} className={w.id === currentId ? 'is-current' : undefined}>
        <td>
          <div className="ws-row-name">
            <span className="ws-badge" aria-hidden="true">{workspaceInitials(w.name)}</span>
            {isEditing ? (
              <form className="ws-rename" onSubmit={saveName}>
                <input
                  className="input"
                  aria-label={`New name for ${w.name}`}
                  maxLength={60}
                  autoFocus
                  value={editing.name}
                  onChange={(e) => setEditing({ id: w.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setEditing(null)
                      setRowError(null)
                    }
                  }}
                />
                <button className="btn btn-primary btn-sm" type="submit" disabled={busyId === w.id}>Save</button>
                <button className="btn btn-sm" type="button" onClick={() => { setEditing(null); setRowError(null) }}>Cancel</button>
              </form>
            ) : (
              <span className="ws-row-title">
                {w.name}
                {w.id === currentId && <span className="ws-tag">Open now</span>}
              </span>
            )}
          </div>
          {rowError?.id === w.id && <p className="ws-error" role="alert">{rowError.message}</p>}
        </td>
        {others.length > 0 && <td className="muted">{w.isMine ? 'You' : w.ownerName}</td>}
        <td className="muted" title={fullDate(w.createdAt)}>{new Date(w.createdAt).toLocaleDateString()}</td>
        <td className="ws-row-actions">
          {w.id !== currentId && <button className="btn btn-sm" onClick={() => onOpen(w.id)}>Open</button>}
          {!isEditing && (
            <button className="btn btn-quiet btn-sm" onClick={() => { setEditing({ id: w.id, name: w.name }); setRowError(null) }}>
              <Icon name="edit" size={15} /> Rename
            </button>
          )}
          <button className="btn btn-quiet btn-sm btn-danger-quiet" onClick={() => void remove(w)} disabled={busyId === w.id}>
            <Icon name="trash" size={15} /> Delete
          </button>
        </td>
      </tr>
    )
  }

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Workspaces</h1>
          <p className="lede">
            A workspace keeps the modules, forms and run history of one project together, for example one for Bata and one
            for Vista. Only you can see your workspaces{isAdmin ? '; as an admin you can also open other people’s' : ''}.
          </p>
        </div>
      </header>

      <form className="ws-create" onSubmit={create}>
        <label htmlFor="ws-create-name">New workspace</label>
        <div className="ws-create-row">
          <input
            id="ws-create-name"
            className="input"
            placeholder="e.g. Bata"
            maxLength={60}
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value)
              setCreateError(null)
            }}
          />
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {creating ? <span className="spinner" /> : <Icon name="plus" size={16} />} Create workspace
          </button>
        </div>
        {createError && <p className="ws-error" role="alert">{createError}</p>}
      </form>

      <section className="ws-section">
        <h2>Your workspaces</h2>
        <table className="ws-table">
          <thead>
            <tr>
              <th>Name</th>
              {others.length > 0 && <th>Owner</th>}
              <th>Created</th>
              <th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>{mine.map(row)}</tbody>
        </table>
      </section>

      {others.length > 0 && (
        <section className="ws-section">
          <h2>Other people’s workspaces</h2>
          <table className="ws-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Created</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>{others.map(row)}</tbody>
          </table>
        </section>
      )}
    </div>
  )
}
