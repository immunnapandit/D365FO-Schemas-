import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import Form from '@rjsf/core'
import { validator } from '../lib/validator'
import { api, ApiError } from '../lib/api'
import { templates } from '../lib/templates'
import { fullDate, timeAgo } from '../lib/format'
import { FIELD_KINDS, fieldProblems, fromFields, newField, toFields, type DesignField, type FieldKind } from '../lib/designer'
import type { AuthType, FormDefinition, FormVersion } from '../lib/types'
import ErrorBoundary from './ErrorBoundary'
import Icon from './Icon'
import { FORM_ICONS, isFormIcon } from '../lib/icons'
import { useFeedback } from '../lib/feedback'

const JsonEditor = lazy(() => import('./JsonEditor'))

let definitionSchemaCache: Promise<object> | null = null
const loadDefinitionSchema = () => (definitionSchemaCache ??= api.definitionSchema().catch(() => ({})))

const MASK = '••••••••'

interface Props {
  mode: 'new' | 'edit'
  initial: FormDefinition | null
  categories: string[]
  onSaved: (def: FormDefinition) => void
  onCancel: () => void
  onDeleted: (id: string) => void
}

/** What the admin edits: everything except the fields the server owns. */
function editable(def: FormDefinition): FormDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, version, createdAt, createdBy, updatedAt, updatedBy, ...rest } = def
  if (!isFormIcon(rest.icon)) rest.icon = 'document'
  return rest
}

type Tab = 'details' | 'connection' | 'request' | 'fields' | 'json' | 'versions'

const AUTH_OPTIONS: { value: AuthType; label: string; hint: string }[] = [
  { value: 'oauth2_client_credentials', label: 'Microsoft Entra ID app (client ID and secret)', hint: 'Used by D365 Finance & Operations and other Entra ID protected APIs.' },
  { value: 'oauth2_password', label: 'Token URL with user name and password', hint: 'OAuth 2.0 sign-in with a service account.' },
  { value: 'token_endpoint', label: 'Custom login request', hint: 'Call any login URL and read the token from its response.' },
  { value: 'bearer_static', label: 'Fixed bearer token', hint: 'A token you already have.' },
  { value: 'basic', label: 'Basic (user name and password)', hint: 'Sent with every request.' },
  { value: 'api_key', label: 'API key header', hint: 'A fixed header such as Ocp-Apim-Subscription-Key.' },
  { value: 'none', label: 'No authentication', hint: 'The API is open.' },
]

/* ------------------------------------------------------------------ small inputs */

function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; wide?: boolean }) {
  const id = useId()
  return (
    <div className={`field ${wide ? 'field-wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}

function Text(props: {
  label: string; value: unknown; onChange: (v: string) => void; hint?: ReactNode
  placeholder?: string; mono?: boolean; wide?: boolean; secret?: boolean
}) {
  const value = typeof props.value === 'string' ? props.value : props.value == null ? '' : String(props.value)
  const stored = props.secret && value === MASK
  return (
    <Field
      label={props.label}
      wide={props.wide}
      hint={stored ? 'A value is stored and hidden. Type to replace it.' : props.hint}
    >
      {(id) => (
        <input
          id={id}
          className={`input ${props.mono ? 'mono' : ''}`}
          // typed secrets are hidden; {{kv:...}} / {{env:...}} references stay readable
          type={props.secret && value !== '' && !value.trimStart().startsWith('{{') ? 'password' : 'text'}
          value={value}
          placeholder={props.placeholder}
          spellCheck={false}
          autoComplete={props.secret ? 'new-password' : 'off'}
          onFocus={(e) => stored && e.currentTarget.select()}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
    </Field>
  )
}

/** A JSON value edited as text; only valid JSON is passed on. */
function JsonText({ label, value, onChange, hint, rows = 6 }: {
  label: string; value: unknown; onChange: (v: unknown) => void; hint?: ReactNode; rows?: number
}) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)))
  const [error, setError] = useState<string | null>(null)
  return (
    <Field label={label} wide hint={error ? <span className="bad">Not valid JSON: {error}</span> : hint}>
      {(id) => (
        <textarea
          id={id}
          className="input mono"
          rows={rows}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            const t = e.target.value
            setText(t)
            if (!t.trim()) {
              setError(null)
              onChange(undefined)
              return
            }
            try {
              onChange(JSON.parse(t))
              setError(null)
            } catch (err) {
              setError((err as Error).message)
            }
          }}
        />
      )}
    </Field>
  )
}

function Pairs({ label, value, onChange, keyLabel, valueLabel }: {
  label: string; value: Record<string, string> | undefined; onChange: (v: Record<string, string> | undefined) => void
  keyLabel: string; valueLabel: string
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value ?? {}))
  function commit(next: [string, string][]) {
    setRows(next)
    const obj = Object.fromEntries(next.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]))
    onChange(Object.keys(obj).length ? obj : undefined)
  }
  return (
    <div className="field field-wide">
      <span className="field-label">{label}</span>
      {rows.map(([k, v], i) => (
        <div className="pair-row" key={i}>
          <input className="input mono" aria-label={keyLabel} placeholder={keyLabel} value={k} spellCheck={false}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <input className="input mono" aria-label={valueLabel} placeholder={valueLabel} value={v} spellCheck={false}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <button className="icon-btn" aria-label={`Remove ${k || keyLabel}`} onClick={() => commit(rows.filter((_, j) => j !== i))}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
      <button className="btn btn-quiet btn-sm" onClick={() => setRows([...rows, ['', '']])}>
        <Icon name="plus" size={14} /> Add {keyLabel.toLowerCase()}
      </button>
    </div>
  )
}

const SECRET_HINT = (
  <>Use <code>{'{{kv:secret-name}}'}</code> to read it from Key Vault. A value typed here is stored encrypted.</>
)

/* ------------------------------------------------------------------ panels */

function ConnectionPanel({ def, update }: { def: FormDefinition; update: (d: FormDefinition) => void }) {
  const auth = def.auth as Record<string, unknown> & { type: AuthType }
  const set = (key: string, value: unknown) => {
    const next = { ...auth, [key]: value }
    if (value === '' || value === undefined) delete next[key]
    update({ ...def, auth: next as FormDefinition['auth'] })
  }
  const option = AUTH_OPTIONS.find((o) => o.value === auth.type)
  const oauth = auth.type === 'oauth2_client_credentials' || auth.type === 'oauth2_password'

  return (
    <div className="panel-grid">
      <Field label="How the API is signed in to" wide hint={option?.hint}>
        {(id) => (
          <select id={id} className="input" value={auth.type}
            onChange={(e) => update({ ...def, auth: { type: e.target.value as AuthType } })}>
            {AUTH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </Field>

      {oauth && (
        <>
          <Text label="Token URL" wide mono value={auth.tokenUrl} onChange={(v) => set('tokenUrl', v)}
            placeholder="https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token" />
          <Text label={auth.type === 'oauth2_password' ? 'Client ID (optional)' : 'Client ID'} mono value={auth.clientId} onChange={(v) => set('clientId', v)} />
          <Text label={auth.type === 'oauth2_password' ? 'Client secret (optional)' : 'Client secret'} mono secret value={auth.clientSecret}
            onChange={(v) => set('clientSecret', v)} hint={SECRET_HINT} />
          {auth.type === 'oauth2_password' && (
            <>
              <Text label="User name" value={auth.username} onChange={(v) => set('username', v)} />
              <Text label="Password" mono secret value={auth.password} onChange={(v) => set('password', v)} hint={SECRET_HINT} />
            </>
          )}
          <Text label="Scope" wide mono value={auth.scope} onChange={(v) => set('scope', v)}
            placeholder="https://<environment>.operations.dynamics.com/.default"
            hint="For F&O: the environment URL followed by /.default" />
        </>
      )}

      {auth.type === 'basic' && (
        <>
          <Text label="User name" value={auth.username} onChange={(v) => set('username', v)} />
          <Text label="Password" mono secret value={auth.password} onChange={(v) => set('password', v)} hint={SECRET_HINT} />
        </>
      )}

      {auth.type === 'bearer_static' && (
        <Text label="Token" wide mono secret value={auth.token} onChange={(v) => set('token', v)} hint={SECRET_HINT} />
      )}

      {auth.type === 'api_key' && (
        <>
          <Text label="Header name" mono value={auth.headerName} onChange={(v) => set('headerName', v)} placeholder="Ocp-Apim-Subscription-Key" />
          <Text label="Header value" mono secret value={auth.value} onChange={(v) => set('value', v)} hint={SECRET_HINT} />
        </>
      )}

      {auth.type === 'token_endpoint' && (
        <>
          <Text label="Login URL" wide mono value={auth.url} onChange={(v) => set('url', v)} placeholder="https://api.contoso.com/auth/login" />
          <Field label="Method">
            {(id) => (
              <select id={id} className="input" value={(auth.method as string) ?? 'POST'} onChange={(e) => set('method', e.target.value)}>
                {['POST', 'GET', 'PUT'].map((m) => <option key={m}>{m}</option>)}
              </select>
            )}
          </Field>
          <Field label="Send the body as">
            {(id) => (
              <select id={id} className="input" value={(auth.bodyType as string) ?? 'json'} onChange={(e) => set('bodyType', e.target.value)}>
                <option value="json">JSON</option>
                <option value="form">Form fields (x-www-form-urlencoded)</option>
              </select>
            )}
          </Field>
          <JsonText label="Login request body" value={auth.body} onChange={(v) => set('body', v)}
            hint={<>For example <code>{'{ "username": "svc-user", "password": "{{kv:api-password}}" }'}</code></>} />
          <Text label="Where the token is in the response" mono value={auth.tokenPath} onChange={(v) => set('tokenPath', v)}
            placeholder="access_token" hint="Use dots for nested values, for example data.token" />
          <Text label="Where the lifetime (seconds) is" mono value={auth.expiresInPath} onChange={(v) => set('expiresInPath', v)} placeholder="expires_in" />
          <Text label="Header the token is sent in" mono value={auth.headerName} onChange={(v) => set('headerName', v)} placeholder="Authorization" />
          <Text label="Text before the token" mono value={auth.prefix} onChange={(v) => set('prefix', v)} placeholder="Bearer " />
        </>
      )}

      {auth.type === 'none' && <p className="muted field-wide">Requests are sent without credentials.</p>}
    </div>
  )
}

function RequestPanel({ def, update }: { def: FormDefinition; update: (d: FormDefinition) => void }) {
  const apiCfg = def.api
  const set = (key: keyof FormDefinition['api'], value: unknown) => {
    const next = { ...apiCfg, [key]: value } as Record<string, unknown>
    if (value === '' || value === undefined) delete next[key]
    update({ ...def, api: next as FormDefinition['api'] })
  }
  const custom = apiCfg.bodyTemplate !== undefined
  const fieldKeys = Object.keys((def.formSchema?.properties as object) ?? {})

  return (
    <div className="panel-grid">
      <Field label="Method">
        {(id) => (
          <select id={id} className="input" value={apiCfg.method ?? 'POST'} onChange={(e) => set('method', e.target.value)}>
            {['POST', 'PUT', 'PATCH', 'GET', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
          </select>
        )}
      </Field>
      <Field label="Give up after (seconds)" hint="Leave empty for the default of 60.">
        {(id) => (
          <input id={id} className="input" type="number" min={1} max={300}
            value={apiCfg.timeoutMs ? apiCfg.timeoutMs / 1000 : ''}
            onChange={(e) => set('timeoutMs', e.target.value ? Math.round(Number(e.target.value) * 1000) : undefined)} />
        )}
      </Field>
      <Text label="URL" wide mono value={apiCfg.url} onChange={(v) => set('url', v)}
        placeholder="{{env:FNO_BASE_URL}}/data/SalesOrderHeadersV2"
        hint={<>OData entity: <code>/data/EntityName</code>. Custom service: <code>/api/services/Group/Service/operation</code>.</>} />

      <Pairs label="Headers" keyLabel="Header" valueLabel="Value" value={apiCfg.headers} onChange={(v) => set('headers', v)} />
      <Pairs label="Query string" keyLabel="Parameter" valueLabel="Value" value={apiCfg.query} onChange={(v) => set('query', v)} />

      <div className="field field-wide">
        <span className="field-label">Request body</span>
        <label className="choice">
          <input type="radio" name="bodymode" checked={!custom} onChange={() => set('bodyTemplate', undefined)} />
          <span>Send the form fields as they are<small>Each field name becomes a property of the JSON body.</small></span>
        </label>
        <label className="choice">
          <input type="radio" name="bodymode" checked={custom}
            onChange={() => set('bodyTemplate', Object.fromEntries(fieldKeys.map((k) => [k, `{{form.${k}}}`])))} />
          <span>Shape the body yourself<small>Needed for custom services and for date or number conversions.</small></span>
        </label>
      </div>
      {custom && (
        <JsonText key="body" label="Body template" rows={10} value={apiCfg.bodyTemplate} onChange={(v) => set('bodyTemplate', v ?? {})}
          hint={<>Insert a field with <code>{'{{form.FieldName}}'}</code>. Converters: <code>| datetime</code>, <code>| number</code>, <code>| lower</code>, <code>| upper</code>.</>} />
      )}

      <Text label="Message shown when it succeeds" wide value={apiCfg.successMessage} onChange={(v) => set('successMessage', v)}
        placeholder="Sales order {{response.SalesOrderNumber}} created."
        hint={<>Use <code>{'{{response.FieldName}}'}</code> for values the API returns.</>} />
    </div>
  )
}

function FieldsPanel({ def, update, openJson }: { def: FormDefinition; update: (d: FormDefinition) => void; openJson: () => void }) {
  const [fields, setFields] = useState<DesignField[] | null>(() => toFields(def.formSchema, def.uiSchema))
  const [open, setOpen] = useState<string | null>(null)

  if (!fields) {
    return (
      <div className="empty">
        <p>This form uses nested groups, lists or conditions, which are edited as JSON.</p>
        <button className="btn" onClick={openJson}>Open the JSON tab</button>
      </div>
    )
  }

  const list: DesignField[] = fields

  function commit(next: DesignField[]) {
    setFields(next)
    update({ ...def, ...fromFields(next, def.formSchema, def.uiSchema) })
  }
  const patch = (uid: string, change: Partial<DesignField>) => commit(list.map((f) => (f.uid === uid ? { ...f, ...change } : f)))
  function move(i: number, dir: -1 | 1) {
    const next = [...list]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    commit(next)
  }
  function add() {
    const f = newField(list.map((x) => x.key))
    commit([...list, f])
    setOpen(f.uid)
  }

  return (
    <div className="fields">
      <p className="muted fields-intro">
        Field names must match what the API expects, for example the OData field <code>OrderingCustomerAccountNumber</code>.
      </p>
      {list.length === 0 && <div className="empty"><p>No fields yet. Add the first field the user has to fill in.</p></div>}
      {list.length > 0 && (
        <div className="field-table" role="table" aria-label="Form fields">
          <div className="field-head" role="row">
            <span role="columnheader">Field name</span>
            <span role="columnheader">Label</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Required</span>
            <span role="columnheader" className="sr-only">Actions</span>
          </div>
          {list.map((f, i) => (
            <div key={f.uid} className={`field-item ${open === f.uid ? 'open' : ''}`}>
              <div className="field-row" role="row">
                <input className="input mono" aria-label="Field name" value={f.key} spellCheck={false} onChange={(e) => patch(f.uid, { key: e.target.value })} />
                <input className="input" aria-label="Label" value={f.label} placeholder={f.key} onChange={(e) => patch(f.uid, { label: e.target.value })} />
                <select className="input" aria-label="Type" value={f.kind} onChange={(e) => patch(f.uid, { kind: e.target.value as FieldKind })}>
                  {FIELD_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
                <label className="check-cell">
                  <input type="checkbox" checked={f.required} onChange={(e) => patch(f.uid, { required: e.target.checked })} />
                  <span className="sr-only">Required</span>
                </label>
                <div className="row-actions">
                  <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" size={16} /></button>
                  <button className="icon-btn" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}><Icon name="down" size={16} /></button>
                  <button className="btn btn-quiet btn-sm" aria-expanded={open === f.uid} onClick={() => setOpen(open === f.uid ? null : f.uid)}>
                    {open === f.uid ? 'Less' : 'More'}
                  </button>
                  <button className="icon-btn danger" aria-label={`Remove ${f.key}`} onClick={() => commit(list.filter((x) => x.uid !== f.uid))}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </div>
              {open === f.uid && (
                <div className="field-more panel-grid">
                  {f.kind === 'dropdown' && (
                    <Field label="Options, one per line" wide>
                      {(id) => <textarea id={id} className="input" rows={4} value={f.options} onChange={(e) => patch(f.uid, { options: e.target.value })} />}
                    </Field>
                  )}
                  <Text label="Default value" value={f.defaultValue} onChange={(v) => patch(f.uid, { defaultValue: v })}
                    hint={f.kind === 'checkbox' ? 'true or false' : undefined} />
                  {f.kind !== 'checkbox' && f.kind !== 'dropdown' && f.kind !== 'date' && f.kind !== 'datetime' && (
                    <Text label="Example shown in the empty field" value={f.placeholder} onChange={(v) => patch(f.uid, { placeholder: v })} />
                  )}
                  <Text label="Help text under the field" wide value={f.help} onChange={(v) => patch(f.uid, { help: v })} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <button className="btn" onClick={add}><Icon name="plus" size={16} /> Add field</button>
    </div>
  )
}

const CHANGE_LABEL: Record<FormVersion['changeType'], string> = { create: 'Created', update: 'Edited', delete: 'Deleted', restore: 'Restored' }

/* ------------------------------------------------------------------ designer */

export default function SchemaEditor({ mode, initial, categories, onSaved, onCancel, onDeleted }: Props) {
  const { confirm, notify } = useFeedback()
  const isEdit = mode === 'edit' && !!initial?.id
  const [templateKey, setTemplateKey] = useState(templates[0].key)
  const [def, setDef] = useState<FormDefinition>(() => editable(initial ?? templates[0].def))
  const [text, setText] = useState(() => JSON.stringify(editable(initial ?? templates[0].def), null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('details')
  const [panelKey, setPanelKey] = useState(0) // remounts panels after the definition is replaced
  const [baseVersion, setBaseVersion] = useState(initial?.version)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [conflict, setConflict] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [defSchema, setDefSchema] = useState<object | null>(null)
  const [versions, setVersions] = useState<FormVersion[] | null>(null)
  const listId = useId()

  useEffect(() => {
    void loadDefinitionSchema().then(setDefSchema)
  }, [])

  // warn before closing the browser tab with unsaved changes
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const update = useCallback((next: FormDefinition) => {
    setDef(next)
    setText(JSON.stringify(next, null, 2))
    setJsonError(null)
    setDirty(true)
  }, [])

  function replace(next: FormDefinition, markDirty: boolean) {
    const clean = editable(next)
    setDef(clean)
    setText(JSON.stringify(clean, null, 2))
    setJsonError(null)
    setDirty(markDirty)
    setPanelKey((k) => k + 1)
  }

  function editJson(value: string) {
    setText(value)
    setDirty(true)
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The definition must be an object')
      setDef({ auth: { type: 'none' }, api: {}, formSchema: { type: 'object', properties: {} }, ...parsed } as FormDefinition)
      setJsonError(null)
    } catch (e) {
      setJsonError((e as Error).message)
    }
  }

  async function pickTemplate(key: string) {
    const t = templates.find((x) => x.key === key)
    if (!t) return
    if (dirty && !(await confirm({ title: 'Start again from this template?', body: 'What you have entered so far is replaced.', confirmLabel: 'Replace' }))) return
    setTemplateKey(key)
    replace({ ...t.def, name: def.name, category: def.category }, false)
  }

  const localProblems = useMemo(() => {
    const p: string[] = []
    if (jsonError) p.push(`The JSON tab has an error: ${jsonError}`)
    if (!def.name?.trim()) p.push('Give the form a name (Details tab).')
    if (!def.api?.url?.trim()) p.push('Enter the API URL (API request tab).')
    const fields = toFields(def.formSchema, def.uiSchema)
    if (fields) p.push(...fieldProblems(fields))
    return p
  }, [def, jsonError])

  const save = useCallback(async () => {
    if (saving) return
    if (localProblems.length) {
      setErrors(['The form cannot be saved yet', ...localProblems])
      return
    }
    setSaving(true)
    setErrors([])
    setConflict(false)
    try {
      const saved = isEdit ? await api.updateForm(initial!.id!, { ...def, version: baseVersion }) : await api.createForm(def)
      setDirty(false)
      notify('Form saved')
      onSaved(saved)
    } catch (e) {
      const err = e as ApiError
      setConflict(err.status === 409)
      setErrors([err.message, ...(err.details || [])])
    } finally {
      setSaving(false)
    }
  }, [saving, localProblems, isEdit, initial, def, baseVersion, notify, onSaved])

  // Ctrl+S / Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  async function reloadLatest() {
    if (!initial?.id) return
    const latest = await api.getForm(initial.id)
    replace(latest, false)
    setBaseVersion(latest.version)
    setErrors([])
    setConflict(false)
    setNotice(`Version ${latest.version} loaded, saved by ${latest.updatedBy || 'unknown'}.`)
  }

  async function openTab(next: Tab) {
    setTab(next)
    if (next === 'versions' && initial?.id) {
      try {
        setVersions(await api.listVersions(initial.id))
      } catch (e) {
        setErrors([(e as Error).message])
      }
    }
  }

  async function loadVersion(v: FormVersion) {
    if (!initial?.id) return
    if (dirty && !(await confirm({ title: `Load version ${v.version}?`, body: 'Your unsaved changes are replaced.', confirmLabel: 'Load version' }))) return
    try {
      const { snapshot } = await api.getVersion(initial.id, v.id)
      replace(snapshot, true)
      setTab('details')
      setNotice(`Version ${v.version} is loaded. Save the form to make it the current version.`)
    } catch (e) {
      setErrors([(e as Error).message])
    }
  }

  async function remove() {
    if (!initial?.id) return
    const ok = await confirm({
      title: `Delete "${initial.name}"?`,
      body: 'Users will no longer see this form. Its submission history is kept.',
      confirmLabel: 'Delete form',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteForm(initial.id)
      setDirty(false)
      notify('Form deleted')
      onDeleted(initial.id)
    } catch (e) {
      setErrors([(e as Error).message])
    }
  }

  async function cancel() {
    if (dirty && !(await confirm({ title: 'Discard your changes?', body: 'Changes you have not saved are lost.', confirmLabel: 'Discard changes', danger: true }))) return
    onCancel()
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'details', label: 'Details' },
    { id: 'connection', label: 'Sign-in' },
    { id: 'request', label: 'API request' },
    { id: 'fields', label: 'Fields' },
    { id: 'json', label: 'JSON' },
    ...(isEdit ? [{ id: 'versions' as Tab, label: 'Versions' }] : []),
  ]

  return (
    <div className="designer">
      <header className="designer-head">
        <div className="designer-title">
          <h1>{isEdit ? def.name || initial?.name : 'New form'}</h1>
          {isEdit && <span className="tag">Version {baseVersion}</span>}
          {dirty && <span className="tag tag-warn">Unsaved changes</span>}
        </div>
        <div className="actions">
          {isEdit && <button className="btn btn-quiet danger" onClick={remove}>Delete form</button>}
          <button className="btn" onClick={cancel}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save form'}</button>
        </div>
      </header>

      {notice && (
        <div className="banner banner-info">
          <span>{notice}</span>
          <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss"><Icon name="x" size={16} /></button>
        </div>
      )}
      {errors.length > 0 && (
        <div className="banner banner-error" role="alert">
          <div>
            <strong>{errors[0]}</strong>
            {errors.length > 1 && <ul>{errors.slice(1).map((e, i) => <li key={i}>{e}</li>)}</ul>}
            {conflict && <button className="btn btn-sm" onClick={reloadLatest}>Load the latest version</button>}
          </div>
          <button className="icon-btn" onClick={() => setErrors([])} aria-label="Dismiss"><Icon name="x" size={16} /></button>
        </div>
      )}

      <div className="designer-body">
        <section className="designer-main">
          <div className="tabs" role="tablist" aria-label="Form settings">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => openTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          <div className={`tab-panel ${tab === 'json' ? 'tab-panel-flush' : ''}`} role="tabpanel" key={`${tab}-${panelKey}`}>
            {tab !== 'json' && tab !== 'versions' && jsonError && (
              <div className="empty">
                <p>The JSON tab has an error. Fix it there before using this tab.</p>
                <button className="btn" onClick={() => setTab('json')}>Open the JSON tab</button>
              </div>
            )}

            {tab === 'details' && !jsonError && (
              <div className="panel-grid">
                {!isEdit && (
                  <Field label="Start from" wide hint={templates.find((t) => t.key === templateKey)?.description}>
                    {(id) => (
                      <select id={id} className="input" value={templateKey} onChange={(e) => void pickTemplate(e.target.value)}>
                        {templates.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                      </select>
                    )}
                  </Field>
                )}
                <Text label="Name" value={def.name} onChange={(v) => update({ ...def, name: v })} placeholder="Create sales order" />
                <Field label="Module" hint="Forms are grouped by module in the navigation.">
                  {(id) => (
                    <>
                      <input id={id} className="input" list={listId} value={def.category ?? ''} placeholder="Sales and marketing"
                        onChange={(e) => update({ ...def, category: e.target.value || undefined })} />
                      <datalist id={listId}>{categories.map((c) => <option key={c} value={c} />)}</datalist>
                    </>
                  )}
                </Field>
                <Text label="Description" wide value={def.description} onChange={(v) => update({ ...def, description: v || undefined })}
                  hint="Shown under the form name." />
                <div className="field field-wide">
                  <span className="field-label">Icon</span>
                  <div className="icon-grid" role="radiogroup" aria-label="Icon">
                    {FORM_ICONS.map((name) => (
                      <button key={name} role="radio" aria-checked={def.icon === name} aria-label={name}
                        className={def.icon === name ? 'on' : ''} onClick={() => update({ ...def, icon: name })}>
                        <Icon name={name} size={20} />
                      </button>
                    ))}
                  </div>
                </div>
                <Text label="Only for these roles (optional)" wide mono
                  value={(def.allowedRoles ?? []).join(', ')}
                  onChange={(v) => {
                    const roles = v.split(',').map((r) => r.trim()).filter(Boolean)
                    update({ ...def, allowedRoles: roles.length ? roles : undefined })
                  }}
                  hint="Entra ID app role values, separated by commas. Leave empty to show the form to every user." />
              </div>
            )}
            {tab === 'connection' && !jsonError && <ConnectionPanel def={def} update={update} />}
            {tab === 'request' && !jsonError && <RequestPanel def={def} update={update} />}
            {tab === 'fields' && !jsonError && <FieldsPanel def={def} update={update} openJson={() => setTab('json')} />}

            {tab === 'json' && (
              <div className="json-pane">
                <div className="json-status">
                  {jsonError ? <span className="bad">Not valid: {jsonError}</span> : <span className="good">Valid JSON</span>}
                  <span className="muted">The complete definition. Changes here update the other tabs.</span>
                </div>
                <div className="monaco-wrap">
                  <Suspense fallback={<div className="muted pad">Loading the editor…</div>}>
                    <JsonEditor value={text} onChange={editJson} schema={defSchema} />
                  </Suspense>
                </div>
              </div>
            )}

            {tab === 'versions' && (
              <div className="versions">
                {!versions && <p className="muted">Loading…</p>}
                {versions?.map((v) => (
                  <div key={v.id} className="version-row">
                    <div>
                      <strong>Version {v.version}</strong>
                      <span className="muted"> {CHANGE_LABEL[v.changeType]} by {v.changedBy || 'unknown'}, </span>
                      <span className="muted" title={fullDate(v.changedAt)}>{timeAgo(v.changedAt)}</span>
                    </div>
                    {v.version === baseVersion
                      ? <span className="tag">Current</span>
                      : v.changeType !== 'delete' && <button className="btn btn-sm" onClick={() => loadVersion(v)}>Load this version</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="designer-preview" aria-label="Preview">
          <h2>Preview</h2>
          <div className="preview-frame">
            <div className="preview-title">
              <span className="form-glyph"><Icon name={def.icon} size={18} /></span>
              <div>
                <strong>{def.name || 'Untitled form'}</strong>
                {def.description && <p className="muted">{def.description}</p>}
              </div>
            </div>
            {def.formSchema && Object.keys((def.formSchema.properties as object) ?? {}).length > 0 ? (
              <ErrorBoundary resetKey={text}>
                <Form schema={def.formSchema} uiSchema={def.uiSchema} validator={validator} showErrorList={false} noHtml5Validate>
                  <div className="form-actions"><button type="button" className="btn btn-primary" disabled>Submit</button></div>
                </Form>
              </ErrorBoundary>
            ) : (
              <p className="muted">Fields you add appear here.</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
