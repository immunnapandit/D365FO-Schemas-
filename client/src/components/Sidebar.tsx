import { useMemo, useState } from 'react'
import { canSignOut, signOut } from '../lib/auth'
import type { CurrentUser, FormSummary } from '../lib/types'
import { groupByModule, UNGROUPED } from '../lib/modules'
import Icon from './Icon'

interface Props {
  forms: FormSummary[]
  selectedId: string | null
  loading: boolean
  user: CurrentUser
  onSelect: (id: string) => void
  onNew: () => void
  onImport: () => void
  onModule: (name: string) => void
  selectedModule: string | null
  onHome: () => void
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('')

export default function Sidebar({ forms, selectedId, loading, user, onSelect, onNew, onImport, onModule, selectedModule, onHome }: Props) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = s ? forms.filter((f) => `${f.name} ${f.description ?? ''} ${f.category ?? ''}`.toLowerCase().includes(s)) : forms
    return groupByModule(list)
  }, [forms, q])

  return (
    <aside className="sidebar">
      <button className="brand" onClick={onHome} title="All forms">
        <span className="brand-mark" aria-hidden="true" />
        <span>Schema Forms</span>
      </button>

      {user.isAdmin && (
        <div className="new-row">
          <button className="btn btn-primary new-btn" onClick={onNew}>
            <Icon name="plus" size={16} /> New form
          </button>
          <button className="btn import-btn" onClick={onImport} title="Import a Postman collection exported as OpenAPI">
            <Icon name="upload" size={16} /> Import
          </button>
        </div>
      )}

      <div className="search">
        <Icon name="search" size={16} />
        <input placeholder="Search forms" aria-label="Search forms" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <nav className="nav" aria-label="Forms">
        {loading && <p className="nav-note">Loading…</p>}
        {!loading && groups.length === 0 && (
          <p className="nav-note">{forms.length ? 'No form matches your search.' : 'There are no forms yet.'}</p>
        )}
        {groups.map(([module, items]) => (
          <section key={module}>
            {user.isAdmin && module !== UNGROUPED ? (
              <h2>
                <button
                  className={`module-btn ${selectedModule === module ? 'active' : ''}`}
                  onClick={() => onModule(module)}
                  title={`Sign-in and settings of ${module}`}
                >
                  <span>{module}</span>
                  <Icon name="settings" size={14} />
                </button>
              </h2>
            ) : (
              <h2>{module}</h2>
            )}
            {items.map((f) => (
              <button
                key={f.id}
                className={`nav-item ${f.id === selectedId ? 'active' : ''}`}
                onClick={() => onSelect(f.id)}
                title={f.description || f.name}
                aria-current={f.id === selectedId ? 'page' : undefined}
              >
                <Icon name={f.icon} size={17} />
                <span>{f.name}</span>
              </button>
            ))}
          </section>
        ))}
      </nav>

      <div className="user-box">
        <span className="avatar" aria-hidden="true">{initials(user.name) || '?'}</span>
        <div className="user-text">
          <div className="user-name" title={user.username}>{user.name}</div>
          <div className="user-role">{user.isAdmin ? 'Administrator' : 'User'}</div>
        </div>
        {canSignOut() && (
          <button className="icon-btn" onClick={() => void signOut()} title="Sign out" aria-label="Sign out">
            <Icon name="signout" size={17} />
          </button>
        )}
      </div>
    </aside>
  )
}
