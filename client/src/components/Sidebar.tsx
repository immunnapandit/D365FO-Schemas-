import { useEffect, useMemo, useRef, useState } from 'react'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import { workspaceInitials } from '../lib/workspace'
import { canSignOut, signOut } from '../lib/auth'
import type { CurrentUser, FormSummary, Workspace } from '../lib/types'
import { groupByModule, groupInModule, UNGROUPED } from '../lib/modules'
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
  /** narrow rail with icons only, so forms get the whole width */
  collapsed: boolean
  onToggleCollapsed: () => void
  workspaces: Workspace[]
  workspace: Workspace | null
  onSwitchWorkspace: (id: string) => void
  onCreateWorkspace: (name: string) => Promise<void>
  onManageWorkspaces: () => void
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('')

export default function Sidebar({
  forms, selectedId, loading, user, onSelect, onNew, onImport, onModule, selectedModule, onHome, collapsed, onToggleCollapsed,
  workspaces, workspace, onSwitchWorkspace, onCreateWorkspace, onManageWorkspaces,
}: Props) {
  const [q, setQ] = useState('')
  const [openSwitcher, setOpenSwitcher] = useState(false) // chosen from the collapsed menu
  const canEdit = Boolean(user.canEdit)
  const searchRef = useRef<HTMLInputElement>(null)
  const [focusSearch, setFocusSearch] = useState(false)
  useEffect(() => {
    if (!collapsed && focusSearch) { searchRef.current?.focus(); setFocusSearch(false) }
  }, [collapsed, focusSearch])
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = s ? forms.filter((f) => `${f.name} ${f.description ?? ''} ${f.category ?? ''} ${f.group ?? ''}`.toLowerCase().includes(s)) : forms
    return groupByModule(list)
  }, [forms, q])

  // groups inside a module (Postman folders, OpenAPI tags) open and close; the choice is remembered
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('sf.navGroups') ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem('sf.navGroups', JSON.stringify([...next]))
      } catch {
        /* private mode */
      }
      return next
    })
  const navItem = (f: FormSummary) => (
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
  )

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-rail" aria-label="Navigation (collapsed)">
        <button className="rail-btn rail-brand" onClick={onHome} title="All forms" aria-label="All forms">
          <span className="brand-mark" aria-hidden="true" />
        </button>
        <button className="rail-btn" onClick={() => { setOpenSwitcher(false); onToggleCollapsed() }} title="Expand the menu" aria-label="Expand the menu" aria-expanded="false">
          <Icon name="sidebar" />
        </button>
        <button
          className="rail-btn rail-ws"
          onClick={() => { setOpenSwitcher(true); onToggleCollapsed() }}
          title={`Workspace: ${workspace?.name ?? ''}`}
          aria-label={`Workspace: ${workspace?.name ?? ''}. Switch workspace`}
        >
          <span className="ws-badge" aria-hidden="true">{workspace ? workspaceInitials(workspace.name) : '…'}</span>
        </button>
        <span className="rail-sep" aria-hidden="true" />
        {canEdit && (
          <>
            <button className="rail-btn rail-primary" onClick={onNew} title="New form" aria-label="New form"><Icon name="plus" /></button>
            <button className="rail-btn" onClick={onImport} title="Import" aria-label="Import"><Icon name="upload" /></button>
          </>
        )}
        <button className="rail-btn" onClick={() => { setOpenSwitcher(false); setFocusSearch(true); onToggleCollapsed() }} title="Search forms" aria-label="Search forms">
          <Icon name="search" />
        </button>
        <span className="avatar rail-avatar" title={`${user.name} · ${user.isAdmin ? 'Administrator' : 'User'}`}>{initials(user.name) || '?'}</span>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button className="brand" onClick={onHome} title="All forms">
          <span className="brand-mark" aria-hidden="true" />
          <span>Schema Forms</span>
        </button>
        <button className="icon-btn collapse-btn" onClick={onToggleCollapsed} title="Collapse the menu" aria-label="Collapse the menu" aria-expanded="true">
          <Icon name="sidebar" size={18} />
        </button>
      </div>

      <WorkspaceSwitcher
        key={openSwitcher ? 'opened' : 'closed'}
        workspaces={workspaces}
        current={workspace}
        onSwitch={onSwitchWorkspace}
        onCreate={onCreateWorkspace}
        onManage={onManageWorkspaces}
        startOpen={openSwitcher}
      />

      {canEdit && (
        <div className="new-row">
          <button className="btn btn-primary new-btn" onClick={onNew}>
            <Icon name="plus" size={16} /> New form
          </button>
          <button className="btn import-btn" onClick={onImport} title="Import a Postman collection or an OpenAPI (YAML) file">
            <Icon name="upload" size={16} /> Import
          </button>
        </div>
      )}

      <div className="search">
        <Icon name="search" size={16} />
        <input ref={searchRef} placeholder="Search forms" aria-label="Search forms" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <nav className="nav" aria-label="Forms">
        {loading && <p className="nav-note">Loading…</p>}
        {!loading && groups.length === 0 && (
          <p className="nav-note">{forms.length ? 'No form matches your search.' : 'This workspace has no forms yet.'}</p>
        )}
        {groups.map(([module, items]) => (
          <section key={module}>
            {canEdit && module !== UNGROUPED ? (
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
            {groupInModule(items).map(({ group, forms: list }) => {
              if (!group) return list.map(navItem)
              const key = `${module}::${group}`
              // open when chosen, while searching, or when it holds the open form
              const open = openGroups.has(key) || Boolean(q.trim()) || list.some((f) => f.id === selectedId)
              return (
                <div key={key} className="nav-group">
                  <button
                    className="nav-group-btn"
                    aria-expanded={open}
                    onClick={() => toggleGroup(key)}
                    title={open ? `Hide ${group}` : `Show ${group}`}
                  >
                    <Icon name={open ? 'down' : 'next'} size={14} />
                    <span className="nav-group-name">{group}</span>
                    <span className="nav-group-count">{list.length}</span>
                  </button>
                  {open && <div className="nav-group-items">{list.map(navItem)}</div>}
                </div>
              )
            })}
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
