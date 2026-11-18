import { useCallback, useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import FormRunner from './components/FormRunner'
import SchemaEditor from './components/SchemaEditor'
import ModulePage from './components/ModulePage'
import ImportPage from './components/ImportPage'
import { api, ApiError } from './lib/api'
import { canSignOut, initAuth, signOut } from './lib/auth'
import { groupByModule } from './lib/modules'
import { FeedbackProvider } from './components/Feedback'
import Icon from './components/Icon'
import type { CurrentUser, FormDefinition, FormSummary } from './lib/types'

type View =
  | { kind: 'welcome' }
  | { kind: 'run'; id: string }
  | { kind: 'edit'; def: FormDefinition }
  | { kind: 'new'; def: FormDefinition | null }
  | { kind: 'module'; name: string }
  | { kind: 'import' }

function viewFromHash(): View {
  const m = location.hash.match(/^#\/form\/(.+)$/)
  if (m) return { kind: 'run', id: decodeURIComponent(m[1]) }
  const mod = location.hash.match(/^#\/module\/(.+)$/)
  if (mod) return { kind: 'module', name: decodeURIComponent(mod[1]) }
  return { kind: 'welcome' }
}

type Boot = { phase: 'loading' } | { phase: 'error'; message: string; status?: number } | { phase: 'ready'; user: CurrentUser }

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' })
  const [forms, setForms] = useState<FormSummary[]>([])
  const [formsLoading, setFormsLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: 'welcome' })
  const [menuOpen, setMenuOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setForms(await api.listForms())
      setListError(null)
    } catch (e) {
      setListError((e as Error).message)
    } finally {
      setFormsLoading(false)
    }
  }, [])

  // sign in, then load the user and the forms
  useEffect(() => {
    ;(async () => {
      try {
        await initAuth()
        const user = await api.me()
        setView(viewFromHash())
        setBoot({ phase: 'ready', user })
        await refresh()
      } catch (e) {
        const err = e as ApiError
        setBoot({ phase: 'error', message: err.message, status: err.status })
      }
    })()
  }, [refresh])

  // keep the URL in sync so a refresh / shared link opens the same form
  useEffect(() => {
    if (boot.phase !== 'ready') return
    const hash =
      view.kind === 'run'
        ? `#/form/${encodeURIComponent(view.id)}`
        : view.kind === 'module'
          ? `#/module/${encodeURIComponent(view.name)}`
          : view.kind === 'welcome'
            ? ''
            : location.hash
    if (hash !== location.hash) history.replaceState(null, '', hash || location.pathname)
  }, [view, boot.phase])

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

  const user = boot.user
  const selectedId = view.kind === 'run' ? view.id : view.kind === 'edit' ? view.def.id ?? null : null

  function open(id: string) {
    setView({ kind: 'run', id })
    setMenuOpen(false)
  }
  function newForm(def: FormDefinition | null = null) {
    setView({ kind: 'new', def })
    setMenuOpen(false)
  }

  const categories = [...new Set(forms.map((f) => f.category).filter((c): c is string => !!c))].sort()

  return (
    <FeedbackProvider>
      <div className={`app ${menuOpen ? 'menu-open' : ''}`}>
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
                  <h1>Forms</h1>
                  <p className="lede">
                    {forms.length
                      ? 'Choose a form, fill it in and submit it to the target system.'
                      : user.isAdmin
                        ? 'Create the first form to get started.'
                        : 'No forms are available to you yet. Ask an administrator for access.'}
                  </p>
                </div>
                {user.isAdmin && (
                  <div className="actions">
                    <button className="btn" onClick={() => setView({ kind: 'import' })}><Icon name="upload" size={16} /> Import collection</button>
                    <button className="btn btn-primary" onClick={() => newForm()}><Icon name="plus" size={16} /> New form</button>
                  </div>
                )}
              </header>
              {groupByModule(forms).map(([module, items]) => (
                <section key={module} className="directory">
                  <h2>{module}</h2>
                  <ul>
                    {items.map((f) => (
                      <li key={f.id}>
                        <button onClick={() => open(f.id)}>
                          <span className="form-glyph"><Icon name={f.icon} size={18} /></span>
                          <span className="directory-text">
                            <strong>{f.name}</strong>
                            {f.description && <span>{f.description}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
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

          {view.kind === 'module' && user.isAdmin && (
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

          {view.kind === 'import' && user.isAdmin && (
            <ImportPage
              onCancel={goHome}
              onDone={async (moduleName) => {
                await refresh()
                setView({ kind: 'module', name: moduleName })
              }}
            />
          )}

          {(view.kind === 'edit' || view.kind === 'new') && user.isAdmin && (
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
        </main>
      </div>
    </FeedbackProvider>
  )
}
