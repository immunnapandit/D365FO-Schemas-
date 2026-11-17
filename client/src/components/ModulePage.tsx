import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { ExecuteResult, FormSummary, ModuleDefinition } from '../lib/types'
import { useFeedback } from '../lib/feedback'
import { timeAgo } from '../lib/format'
import AuthFields from './AuthFields'
import { Pairs, Text } from './inputs'
import Icon from './Icon'

interface Props {
  name: string
  forms: FormSummary[]
  onOpenForm: (id: string) => void
  onChanged: (newName?: string) => Promise<void> | void
  onDeleted: () => Promise<void> | void
}

const sameName = (a?: string, b?: string) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
const draftFor = (name: string): ModuleDefinition => ({
  name,
  auth: { type: 'oauth2_client_credentials' },
  variables: {},
  headers: {},
})

/**
 * Settings of one module: the sign-in, {{variables}} and headers shared by all its forms.
 * Forms whose sign-in is "Use the module's sign-in" (all imported forms) use these.
 */
export default function ModulePage({ name, forms, onOpenForm, onChanged, onDeleted }: Props) {
  const { confirm, notify } = useFeedback()
  const [loading, setLoading] = useState(true)
  const [stored, setStored] = useState<ModuleDefinition | null>(null)
  const [mod, setMod] = useState<ModuleDefinition>(() => draftFor(name))
  const [formKey, setFormKey] = useState(0) // remounts the key/value editors after loading
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<ExecuteResult | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const found = (await api.listModules()).find((m) => sameName(m.name, name)) ?? null
      setStored(found)
      setMod(found ?? draftFor(name))
      setFormKey((k) => k + 1)
      setDirty(false)
      setErrors([])
    } catch (e) {
      setErrors([(e as Error).message])
    } finally {
      setLoading(false)
    }
  }, [name])

  useEffect(() => {
    void load()
  }, [load])

  const change = (next: ModuleDefinition) => {
    setMod(next)
    setDirty(true)
    setTest(null)
  }

  async function save() {
    if (!mod.name.trim()) {
      setErrors(['Give the module a name.'])
      return
    }
    setSaving(true)
    setErrors([])
    try {
      const body = { ...mod, variables: mod.variables ?? {}, headers: mod.headers ?? {} }
      const saved = stored?.id ? await api.updateModule(stored.id, { ...body, version: stored.version }) : await api.createModule(body)
      setStored(saved)
      setMod(saved)
      setFormKey((k) => k + 1)
      setDirty(false)
      notify('Module saved')
      await onChanged(saved.name !== name ? saved.name : undefined)
    } catch (e) {
      const err = e as ApiError
      setErrors([err.message, ...(err.details ?? [])])
    } finally {
      setSaving(false)
    }
  }

  async function runTest() {
    if (!stored?.id) return
    setTesting(true)
    setTest(null)
    try {
      setTest(await api.testModuleAuth(stored.id))
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  async function remove() {
    if (!stored?.id) return
    if (!(await confirm({ title: `Delete the module "${stored.name}"?`, body: 'Its sign-in settings are removed.', confirmLabel: 'Delete', danger: true }))) return
    try {
      await api.deleteModule(stored.id)
      notify('Module deleted')
      await onDeleted()
    } catch (e) {
      setErrors([(e as Error).message])
    }
  }

  const emptyVars = Object.entries(mod.variables ?? {}).filter(([, v]) => !v).map(([k]) => k)

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>{stored?.name ?? name}</h1>
          <p className="lede">
            Module settings. The sign-in, variables and headers here are used by every form in this module that is set to
            “Use the module's sign-in”.
          </p>
          {stored?.updatedAt && (
            <p className="muted small">Changed {timeAgo(stored.updatedAt)}{stored.updatedBy ? ` by ${stored.updatedBy}` : ''}</p>
          )}
        </div>
        <div className="actions">
          {stored?.id && (
            <button className="btn" onClick={() => void runTest()} disabled={testing || dirty} title={dirty ? 'Save first' : undefined}>
              {testing ? <span className="spinner" /> : <Icon name="key" size={16} />} Test sign-in
            </button>
          )}
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || loading || (!dirty && !!stored)}>
            {saving ? <span className="spinner" /> : <Icon name="check" size={16} />} {stored ? 'Save' : 'Create module'}
          </button>
        </div>
      </header>

      {loading && <p className="muted">Loading…</p>}

      {!loading && !stored && (
        <div className="banner banner-info">
          <span>This module has no sign-in settings yet. Fill them in and choose Create module.</span>
        </div>
      )}
      {!!errors.length && (
        <div className="banner banner-error" role="alert">
          <div>
            {errors[0]}
            {errors.length > 1 && <ul>{errors.slice(1).map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </div>
        </div>
      )}
      {test && (
        <div className={`banner ${test.ok ? 'banner-ok' : 'banner-error'}`} role={test.ok ? 'status' : 'alert'}>
          <div>
            {test.ok ? 'Sign-in works. A token was received.' : test.message}
            {!!test.details?.length && <ul>{test.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
          </div>
        </div>
      )}

      {!loading && (
        <div key={formKey} className="module-sections">
          <section className="card-section">
            <h2>Module</h2>
            <div className="panel-grid">
              <Text label="Name" value={mod.name} onChange={(v) => change({ ...mod, name: v })}
                hint="Shown in the sidebar. Renaming moves its forms along." />
              <Text label="Description" value={mod.description} onChange={(v) => change({ ...mod, description: v || undefined })} />
            </div>
          </section>

          <section className="card-section">
            <h2>Sign-in</h2>
            <p className="muted section-intro">The backend gets the token with these settings before every call, so users never handle tokens.</p>
            <AuthFields value={mod.auth} onChange={(auth) => change({ ...mod, auth })} />
          </section>

          <section className="card-section">
            <h2>Variables</h2>
            <p className="muted section-intro">
              Values for placeholders such as <code>{'{{tenantId}}'}</code> in URLs and sign-in fields, like Postman collection variables.
              Values with secret-like names are stored encrypted.
            </p>
            {!!emptyVars.length && (
              <p className="tag tag-warn">No value yet: {emptyVars.join(', ')}</p>
            )}
            <Pairs label="" keyLabel="Variable" valueLabel="Value" value={mod.variables}
              onChange={(v) => change({ ...mod, variables: v ?? {} })} />
          </section>

          <section className="card-section">
            <h2>Headers for every request</h2>
            <p className="muted section-intro">For example <code>Ocp-Apim-Subscription-Key</code> for Azure API Management. Keys are stored encrypted.</p>
            <Pairs label="" keyLabel="Header" valueLabel="Value" value={mod.headers}
              onChange={(v) => change({ ...mod, headers: v ?? {} })} />
          </section>

          <section className="card-section">
            <h2>Forms in this module</h2>
            {forms.length === 0 ? (
              <p className="muted">No forms yet.</p>
            ) : (
              <ul className="plain-list">
                {forms.map((f) => (
                  <li key={f.id}>
                    <button className="link-btn" onClick={() => onOpenForm(f.id)}>
                      <Icon name={f.icon} size={16} /> {f.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {stored?.id && forms.length === 0 && (
              <button className="btn btn-quiet danger" onClick={() => void remove()}>
                <Icon name="trash" size={16} /> Delete module
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
