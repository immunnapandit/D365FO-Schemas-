import { useCallback, useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import FormRunner from './components/FormRunner'
import SchemaEditor from './components/SchemaEditor'
import ModulePage from './components/ModulePage'
import ImportPage from './components/ImportPage'
import WorkspacesPage from './components/WorkspacesPage'
import { api, ApiError } from './lib/api'
import { canSignOut, initAuth, signOut } from './lib/auth'
import { groupByModule, groupInModule } from './lib/modules'
import { useNarrow } from './lib/use-narrow'
import { currentWorkspaceId, setCurrentWorkspaceId } from './lib/workspace'
import { FeedbackProvider } from './components/Feedback'
import Icon from './components/Icon'
import type { CurrentUser, FormDefinition, FormSummary, Workspace } from './lib/types'

type View =
  | { kind: 'welcome' }
  | { kind: 'run'; id: string }
  | { kind: 'edit'; def: FormDefinition }
  | { kind: 'new'; def: FormDefinition | null }
  | { kind: 'module'; name: string }
  | { kind: 'import' }
  | { kind: 'workspaces' }

/** Links look like #/w/<workspace>/form/<form>, so a shared or refreshed link opens the right workspace. */
function fromHash(): { view: View; workspaceId: string | null } {
  const ws = location.hash.match(/^#\/w\/([^/]+)/)
  const workspaceId = ws ? decodeURIComponent(ws[1]) : null
  const rest = ws ? location.hash.slice(ws[0].length) : location.hash.replace(/^#/, '')
  const m = rest.match(/^\/form\/(.+)$/)
  if (m) return { view: { kind: 'run', id: decodeURIComponent(m[1]) }, workspaceId }
  const mod = rest.match(/^\/module\/(.+)$/)
  if (mod) return { view: { kind: 'module', name: decodeURIComponent(mod[1]) }, workspaceId }
  if (rest === '/workspaces') return { view: { kind: 'workspaces' }, workspaceId }
  return { view: { kind: 'welcome' }, workspaceId }
}

/** The workspace to open: the one asked for (link or last used) if the user can open it, else their first. */
function pickWorkspace(list: Workspace[], wanted: (string | null)[]): Workspace | null {
  for (const id of wanted) {
    const w = id && list.find((x) => x.id === id)
    if (w) return w
  }
  return list.find((w) => w.isMine) ?? list[0] ?? null
}

type Boot = { phase: 'loading' } | { phase: 'error'; message: string; status?: number } | { phase: 'ready'; user: CurrentUser }

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' })
  const [forms, setForms] = useState<FormSummary[]>([])
  const [formsLoading, setFormsLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: 'welcome' })
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try { return localStorage.getItem('sf.navCollapsed') === '1' } catch { return false }
  })
  const narrow = useNarrow()
  const collapsed = navCollapsed && !narrow
  const toggleNav = () => {
    setNavCollapsed((c) => {
      try { localStorage.setItem('sf.navCollapsed', c ? '0' : '1') } catch { /* private mode */ }
      return !c
    })
  }

  const selectWorkspace = useCallback((w: Workspace | null) => {
    setCurrentWorkspaceId(w?.id ?? null)
    setWorkspaceId(w?.id ?? null)
  }, [])

  const loadWorkspaces = useCallback(async (isAdmin: boolean) => {
    const list = await api.listWorkspaces(isAdmin)
    setWorkspaces(list)
    return list
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setForms(await api.listForms())
      setListError(null)
    } catch (e) {
      const err = e as ApiError
      if (err.code === 'workspace_not_found') {
        // the workspace was deleted or is no longer ours: go to the user's first workspace
        const list = await api.listWorkspaces()
        setWorkspaces((prev) => [...list, ...prev.filter((w) => !w.isMine && list.every((x) => x.id !== w.id))])
        const first = pickWorkspace(list, [])
        setCurrentWorkspaceId(first?.id ?? null)
        setWorkspaceId(first?.id ?? null)
        setView({ kind: 'welcome' })
        if (first) {
          try {
            setForms(await api.listForms())
            setListError(null)
            return
          } catch (again) {
            setListError((again as Error).message)
            return
          }
        }
      }
      setListError(err.message)
    } finally {
      setFormsLoading(false)
    }
  }, [])

  // sign in, then load the user, the workspaces and the forms
  useEffect(() => {
    ;(async () => {
      try {
        await initAuth()
        const user = await api.me()
        const fromLink = fromHash()
        const list = await loadWorkspaces(user.isAdmin)
        selectWorkspace(pickWorkspace(list, [fromLink.workspaceId, currentWorkspaceId()]))
        setView(fromLink.view)
        setBoot({ phase: 'ready', user })
        await refresh()
      } catch (e) {
        const err = e as ApiError
        setBoot({ phase: 'error', message: err.message, status: err.status })
      }
    })()
  }, [refresh, loadWorkspaces, selectWorkspace])

  // keep the URL in sync so a refresh / shared link opens the same form
  useEffect(() => {
    if (boot.phase !== 'ready' || !workspaceId) return
    const ws = `#/w/${encodeURIComponent(workspaceId)}`
    const hash =
      view.kind === 'run'
        ? `${ws}/form/${encodeURIComponent(view.id)}`
        : view.kind === 'module'
          ? `${ws}/module/${encodeURIComponent(view.name)}`
          : view.kind === 'workspaces'
            ? `${ws}/workspaces`
            : ws
    if (hash !== location.hash) history.replaceState(null, '', hash)
  }, [view, boot.phase, workspaceId])

  const goHome = useCallback(() => setView({ kind: 'welcome' }), [])

  if (boot.phase === 'loading') {
    return (
      <div className="center-screen">
        <span className="spinner large" />
        <p className="muted">Signing you in…</p>
      </div>
    )
  }
  if (boot.phase === 'error') {
    return (
      <div className="center-screen">
        <span className="brand-mark large" aria-hidden="true" />
        <h1>{boot.status === 403 ? 'You do not have access' : 'Schema Forms could not start'}</h1>
        <p className="muted narrow">{boot.message}</p>
        <div className="actions">
          <button className="btn" onClick={() => location.reload()}>Try again</button>
          {canSignOut() && <button className="btn" onClick={() => void signOut()}>Use another account</button>}
        </div>
      </div>
    )
  }

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null
  const user: CurrentUser = { ...boot.user, canEdit: Boolean(workspace?.canEdit) }
  const selectedId = view.kind === 'run' ? view.id : view.kind === 'edit' ? view.def.id ?? null : null

  function open(id: string) {
    setView({ kind: 'run', id })
    setMenuOpen(false)
  }
  function newForm(def: FormDefinition | null = null) {
    setView({ kind: 'new', def })
    setMenuOpen(false)
  }

  function switchWorkspace(id: string) {
    const w = workspaces.find((x) => x.id === id)
    if (!w) return
    selectWorkspace(w)
    setForms([])
    setFormsLoading(true)
    setListError(null)
    setView({ kind: 'welcome' })
    setMenuOpen(false)
    void refresh()
  }
  async function createWorkspace(name: string) {
    const created = await api.createWorkspace(name)
    setWorkspaces((prev) => [...prev, created].sort((a, b) => Number(b.isMine) - Number(a.isMine) || a.name.localeCompare(b.name)))
    selectWorkspace(created)
    setForms([])
    setFormsLoading(true)
    setListError(null)
    setView({ kind: 'welcome' })
    setMenuOpen(false)
    await refresh()
  }
  async function renameWorkspace(id: string, name: string) {
    const renamed = await api.renameWorkspace(id, name)
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? renamed : w)))
  }
  async function deleteWorkspace(id: string) {
    await api.deleteWorkspace(id)
    const rest = workspaces.filter((w) => w.id !== id)
    setWorkspaces(rest)
    if (id === workspaceId) {
      const next = pickWorkspace(rest, [])
      selectWorkspace(next)
      setForms([])
      setFormsLoading(true)
      await refresh()
      setView({ kind: 'workspaces' })
    }
  }

  const categories = [...new Set(forms.map((f) => f.category).filter((c): c is string => !!c))].sort()

  return (
    <FeedbackProvider>
      <div className={`app ${menuOpen ? 'menu-open' : ''}${collapsed ? ' nav-collapsed' : ''}`}>
        <Sidebar
          forms={forms}
          selectedId={selectedId}
          loading={formsLoading}
          user={user}
          onSelect={open}
          onNew={() => newForm()}
          onImport={() => {
            setView({ kind: 'import' })
            setMenuOpen(false)
          }}
          onModule={(name) => {
            setView({ kind: 'module', name })
            setMenuOpen(false)
          }}
          selectedModule={view.kind === 'module' ? view.name : null}
          onHome={() => {
            goHome()
            setMenuOpen(false)
          }}
          collapsed={collapsed}
          onToggleCollapsed={toggleNav}
          workspaces={workspaces}
          workspace={workspace}
          onSwitchWorkspace={switchWorkspace}
          onCreateWorkspace={createWorkspace}
          onManageWorkspaces={() => {
            setView({ kind: 'workspaces' })
            setMenuOpen(false)
          }}
        />
        <div className="scrim" onClick={() => setMenuOpen(false)} />

        <main className="main">
          <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open navigation">
            <Icon name="menu" size={18} />
          </button>

          {listError && <div className="page"><div className="banner banner-error">{listError}</div></div>}

          {view.kind === 'welcome' && !listError && (
            <div className="page">
              <header className="page-head">
                <div className="page-title">
                  <h1>{workspace?.name ?? 'Forms'}</h1>
                  <p className="lede">
                    {formsLoading
                      ? 'Loading forms…'
                      : forms.length
                        ? 'Choose a form, fill it in and submit it to the target system.'
                        : user.canEdit
                          ? 'This workspace is empty. Import a Postman collection or an OpenAPI file, or create a form.'
                          : 'No forms are available to you yet.'}
                  </p>
                  {workspace && !workspace.isMine && (
                    <p className="banner banner-info ws-banner">You are in {workspace.ownerName ?? 'another person'}’s workspace. Changes you make are saved there.</p>
                  )}
                </div>
                {user.canEdit && (
                  <div className="actions">
                    <button className="btn" onClick={() => setView({ kind: 'import' })}><Icon name="upload" size={16} /> Import collection</button>
                    <button className="btn btn-primary" onClick={() => newForm()}><Icon name="plus" size={16} /> New form</button>
                  </div>
                )}
              </header>
              {groupByModule(forms).map(([module, items]) => (
                <section key={module} className="directory">
                  <h2>
                    {module} <span className="directory-count">{items.length === 1 ? '1 form' : `${items.length} forms`}</span>
                  </h2>
                  {groupInModule(items).map(({ group, forms: list }) => (
                    <div key={group ?? ''} className="directory-group">
                      {group && <h3>{group} <span className="directory-count">{list.length}</span></h3>}
                      <ul>
                        {list.map((f) => (
                          <li key={f.id}>
                            <button onClick={() => open(f.id)} title={f.description || f.name}>
                              <span className="form-glyph"><Icon name={f.icon} size={18} /></span>
                              <span className="directory-text">
                                <strong>{f.name}</strong>
                                {f.description && <span>{f.description}</span>}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}

          {view.kind === 'run' && (
            <FormRunner
              key={view.id}
              id={view.id}
              user={user}
              onMissing={goHome}
              onEdit={(def) => setView({ kind: 'edit', def })}
              onDuplicate={(def) => {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { id, version, createdAt, createdBy, updatedAt, updatedBy, ...rest } = def
                newForm({ ...rest, name: `${def.name} (copy)` })
              }}
            />
          )}

          {view.kind === 'module' && user.canEdit && (
            <ModulePage
              key={view.name}
              name={view.name}
              forms={forms.filter((f) => (f.category ?? '').trim().toLowerCase() === view.name.trim().toLowerCase())}
              onOpenForm={open}
              onChanged={async (newName) => {
                await refresh()
                if (newName) setView({ kind: 'module', name: newName })
              }}
              onDeleted={async () => {
                await refresh()
                setView({ kind: 'welcome' })
              }}
            />
          )}

          {view.kind === 'import' && user.canEdit && (
            <ImportPage
              onCancel={goHome}
              onDone={async (moduleName) => {
                await refresh()
                setView({ kind: 'module', name: moduleName })
              }}
            />
          )}

          {(view.kind === 'edit' || view.kind === 'new') && user.canEdit && (
            <SchemaEditor
              key={view.kind === 'edit' ? `edit-${view.def.id}-${view.def.version}` : `new-${view.def?.name ?? ''}`}
              mode={view.kind}
              initial={view.def}
              categories={categories}
              onSaved={async (saved) => {
                await refresh()
                setView({ kind: 'run', id: saved.id! })
              }}
              onCancel={() =>
                setView(view.kind === 'edit' && view.def.id ? { kind: 'run', id: view.def.id } : { kind: 'welcome' })
              }
              onDeleted={async () => {
                await refresh()
                setView({ kind: 'welcome' })
              }}
            />
          )}
          {view.kind === 'workspaces' && (
            <WorkspacesPage
              workspaces={workspaces}
              currentId={workspaceId}
              isAdmin={user.isAdmin}
              onOpen={switchWorkspace}
              onCreate={async (name) => {
                await createWorkspace(name)
                setView({ kind: 'workspaces' })
              }}
              onRename={renameWorkspace}
              onDelete={deleteWorkspace}
            />
          )}
        </main>
      </div>
    </FeedbackProvider>
  )
}
