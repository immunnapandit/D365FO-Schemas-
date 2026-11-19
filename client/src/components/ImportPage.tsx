import { useId, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { ImportPreview } from '../lib/types'
import { useFeedback } from '../lib/feedback'
import { AUTH_OPTIONS } from '../lib/auth-options'
import Icon from './Icon'

interface Props {
  onDone: (moduleName: string) => Promise<void> | void
  onCancel: () => void
}

const MAX_BYTES = 10 * 1024 * 1024

const FIELD_LABELS: Record<string, string> = {
  tokenUrl: 'token URL',
  clientId: 'client ID',
  clientSecret: 'client secret',
  scope: 'scope',
  username: 'username',
  password: 'password',
  token: 'token',
  headerName: 'header name',
  value: 'key',
}

/**
 * Import a Postman collection (exported JSON) or an OpenAPI file (YAML or JSON).
 * The collection becomes a module; each request becomes a form. The token request becomes
 * the module's sign-in.
 */
export default function ImportPage({ onDone, onCancel }: Props) {
  const { notify } = useFeedback()
  const fileId = useId()
  const textId = useId()
  const nameId = useId()
  const [content, setContent] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [moduleName, setModuleName] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  async function readFile(file: File | undefined) {
    if (!file) return
    if (file.size > MAX_BYTES) {
      setErrors(['The file is larger than 10 MB.'])
      return
    }
    const text = await file.text()
    setFileName(file.name)
    setContent(text)
    await runPreview(text, '')
  }

  async function runPreview(text = content, name = moduleName) {
    if (!text.trim()) {
      setErrors(['Choose a file or paste the OpenAPI content first.'])
      return
    }
    setBusy('preview')
    setErrors([])
    try {
      const p = await api.previewImport(text, name)
      setPreview(p)
      setModuleName(p.moduleName)
      setSelected(new Set(p.requests.map((r) => r.key)))
      if (p.problems.length) setErrors(['Some requests have problems', ...p.problems])
    } catch (e) {
      const err = e as ApiError
      setPreview(null)
      setErrors([err.message, ...(err.details ?? [])])
    } finally {
      setBusy(null)
    }
  }

  async function runImport() {
    if (!preview) return
    setBusy('import')
    setErrors([])
    try {
      const r = await api.runImport(content, moduleName.trim(), [...selected], fileName ?? undefined)
      const parts = [
        r.created.length ? `${r.created.length} form${r.created.length === 1 ? '' : 's'} created` : '',
        r.updated.length ? `${r.updated.length} updated` : '',
      ].filter(Boolean)
      notify(`Imported: ${parts.join(', ')}`)
      await onDone(r.module.name)
    } catch (e) {
      const err = e as ApiError
      setErrors([err.message, ...(err.details ?? [])])
    } finally {
      setBusy(null)
    }
  }

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const authLabel = preview && (AUTH_OPTIONS.find((o) => o.value === preview.auth.type)?.label ?? preview.auth.type)

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Import a collection</h1>
          <p className="lede">
            Import a Postman collection (Export collection, JSON) or an OpenAPI file (YAML or JSON). The collection becomes a
            module and each request becomes a form. The collection's sign-in and variables are taken over; you add what is
            missing, such as the secret, once on the module.
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </header>

      {!!errors.length && (
        <div className="banner banner-error" role="alert">
          <div>
            {errors[0]}
            {errors.length > 1 && <ul>{errors.slice(1).map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </div>
        </div>
      )}

      <section className="card-section">
        <h2>1. The file</h2>
        <div className="import-file">
          <label htmlFor={fileId} className="btn">
            <Icon name="upload" size={16} /> Choose file
          </label>
          <input id={fileId} className="sr-only" type="file" accept=".yaml,.yml,.json,application/json,application/yaml,text/yaml"
            onChange={(e) => void readFile(e.target.files?.[0])} />
          <span className="muted">{fileName ?? 'Postman collection (.json) or OpenAPI (.yaml, .yml, .json), up to 10 MB'}</span>
        </div>
        <details className="paste-box" open={!fileName && !!content}>
          <summary>Or paste the content</summary>
          <label htmlFor={textId} className="sr-only">OpenAPI content</label>
          <textarea id={textId} className="input mono" rows={10} spellCheck={false} value={content}
            placeholder={'openapi: 3.0.0\ninfo:\n  title: My collection\npaths:\n  …'}
            onChange={(e) => {
              setContent(e.target.value)
              setFileName(null)
              setPreview(null)
            }} />
          <button className="btn btn-sm" onClick={() => void runPreview()} disabled={busy !== null}>
            {busy === 'preview' ? <span className="spinner" /> : null} Read it
          </button>
        </details>
      </section>

      {preview && (
        <>
          <section className="card-section">
            <h2>2. Module</h2>
            <div className="panel-grid">
              <div className="field">
                <label htmlFor={nameId}>Module name</label>
                <input id={nameId} className="input" value={moduleName} maxLength={60} onChange={(e) => setModuleName(e.target.value)} />
                <p className="field-hint">
                  {preview.moduleExists && moduleName === preview.moduleName
                    ? 'This module exists. Its sign-in is kept; forms with the same name are updated.'
                    : 'A new module is created with this name.'}
                </p>
              </div>
              <div className="field">
                <span className="field-label">Sign-in found in the file</span>
                <p>{authLabel}</p>
                {preview.auth.tokenUrl && <p className="mono small break">{preview.auth.tokenUrl}</p>}
                <p className="field-hint">
                  {!preview.authSource
                    ? 'No sign-in was found. Set it on the module after the import.'
                    : preview.auth.filled?.length
                      ? `Taken from the ${preview.authSource === 'collection' ? "collection's Authorization" : 'token request'}: ${preview.auth.filled.map((k) => FIELD_LABELS[k] ?? k).join(', ')}. Fill in anything missing on the module.`
                      : 'The token request is not a form. Fill in client ID, secret and scope once on the module.'}
                </p>
              </div>
              {!!preview.variables.length && (
                <div className="field field-wide">
                  <span className="field-label">Variables</span>
                  <p>
                    {preview.variables.map((v) => (
                      <code key={v} className={`var-chip ${preview.variablesWithValue?.includes(v) ? '' : 'var-empty'}`}
                        title={preview.variablesWithValue?.includes(v) ? 'Value taken from the file' : 'No value in the file: fill it in on the module'}>
                        {`{{${v}}}`}
                      </code>
                    ))}
                  </p>
                  {preview.variables.some((v) => !preview.variablesWithValue?.includes(v)) && (
                    <p className="field-hint">Outlined variables have no value in the file. Fill them in on the module after the import.</p>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="card-section">
            <h2>3. Requests</h2>
            {preview.requests.length === 0 ? (
              <p className="muted">The file has no requests besides the token request.</p>
            ) : (
              <table className="runs import-table">
                <thead>
                  <tr>
                    <th><span className="sr-only">Import</span></th>
                    <th>Method</th>
                    <th>Request</th>
                    <th className="num">Fields</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.requests.map((r) => (
                    <tr key={r.key} onClick={() => toggle(r.key)}>
                      <td>
                        <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)}
                          onClick={(e) => e.stopPropagation()} aria-label={`Import ${r.name}`} />
                      </td>
                      <td><span className={`tag method method-${r.method.toLowerCase()}`}>{r.method}</span></td>
                      <td>
                        <div className="ellipsis"><strong>{r.name}</strong></div>
                        <div className="ellipsis muted mono small" title={r.url}>{r.url}</div>
                      </td>
                      <td className="num">{r.fieldCount}</td>
                      <td>{r.exists ? <span className="tag">Update</span> : <span className="badge badge-ok">New</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => void runImport()}
                disabled={busy !== null || !selected.size || !moduleName.trim()}>
                {busy === 'import' ? <span className="spinner" /> : <Icon name="check" size={16} />}
                Import {selected.size} request{selected.size === 1 ? '' : 's'}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
