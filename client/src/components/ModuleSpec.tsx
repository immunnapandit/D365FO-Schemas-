import { lazy, Suspense, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { ImportPreview, ModuleDefinition } from '../lib/types'
import { useFeedback } from '../lib/feedback'
import { fullDate, timeAgo } from '../lib/format'
import Icon from './Icon'

const JsonEditor = lazy(() => import('./JsonEditor'))

interface Props {
  module: ModuleDefinition
  onImported: () => Promise<void> | void
}

/**
 * The file (Postman collection or OpenAPI YAML/JSON) a module was imported from: view it, edit it, check what would change
 * and update the forms from it. Like importing again, without going back to Postman.
 */
export default function ModuleSpec({ module: mod, onImported }: Props) {
  const { confirm, notify } = useFeedback()
  const [content, setContent] = useState<string | null>(null) // null = not loaded
  const [original, setOriginal] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'load' | 'check' | 'save' | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const spec = mod.spec
  const isJson = (content ?? original).trimStart().startsWith('{')
  const changed = content !== null && content !== original

  async function load() {
    setBusy('load')
    setErrors([])
    try {
      const s = await api.getModuleSpec(mod.id!)
      setContent(s.content)
      setOriginal(s.content)
      setOpen(true)
      return s.content
    } catch (e) {
      setErrors([(e as Error).message])
      return null
    } finally {
      setBusy(null)
    }
  }

  async function download() {
    const text = content ?? (await load())
    if (text === null) return
    const blob = new Blob([text], { type: isJson ? 'application/json' : 'application/yaml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = spec?.fileName || `${mod.name}.${isJson ? 'json' : 'yaml'}`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function check() {
    if (content === null) return
    setBusy('check')
    setErrors([])
    try {
      const p = await api.previewImport(content, mod.name)
      setPreview(p)
      if (p.problems.length) setErrors(['Some requests have problems', ...p.problems])
    } catch (e) {
      const err = e as ApiError
      setPreview(null)
      setErrors([err.message, ...(err.details ?? [])])
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    if (content === null) return
    const ok = await confirm({
      title: 'Update the forms from this file?',
      body: 'Forms with the same name get the new URL and fields (a new version each). New requests become new forms. The sign-in is kept.',
      confirmLabel: 'Update forms',
    })
    if (!ok) return
    setBusy('save')
    setErrors([])
    try {
      const r = await api.runImport(content, mod.name, undefined, spec?.fileName)
      setOriginal(content)
      setPreview(null)
      notify(`Forms updated: ${r.updated.length} updated, ${r.created.length} new`)
      await onImported()
    } catch (e) {
      const err = e as ApiError
      setErrors([err.message, ...(err.details ?? [])])
    } finally {
      setBusy(null)
    }
  }

  async function discard() {
    if (changed && !(await confirm({ title: 'Discard your changes to the file?', confirmLabel: 'Discard', danger: true }))) return
    setContent(original)
    setPreview(null)
    setErrors([])
  }

  if (!spec) {
    return (
      <section className="card-section">
        <h2>Imported file</h2>
        <p className="muted">This module was not imported from a file. Use Import in the sidebar to add requests from a Postman collection or an OpenAPI (YAML) file.</p>
      </section>
    )
  }

  return (
    <section className="card-section">
      <div className="section-head">
        <div>
          <h2>Imported file</h2>
          <p className="muted small">
            {spec.fileName ? <strong>{spec.fileName}</strong> : 'Imported file'}, changed{' '}
            <span title={fullDate(spec.updatedAt)}>{timeAgo(spec.updatedAt)}</span>
            {spec.updatedBy ? ` by ${spec.updatedBy}` : ''}
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-sm" onClick={() => void download()} disabled={busy !== null}>Download</button>
          {!open && (
            <button className="btn btn-sm" onClick={() => void load()} disabled={busy !== null}>
              {busy === 'load' ? <span className="spinner" /> : null} View and edit
            </button>
          )}
          {open && (
            <button className="btn btn-sm" onClick={() => setOpen(false)}>Hide</button>
          )}
        </div>
      </div>

      {!!errors.length && (
        <div className="banner banner-error" role="alert">
          <div>
            {errors[0]}
            {errors.length > 1 && <ul>{errors.slice(1).map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </div>
        </div>
      )}

      {open && content !== null && (
        <>
          <p className="muted section-intro">
            Edit the file here, for example to add a field to a request body, then update the forms. Requests removed from the
            file are not deleted; delete those forms yourself. Secret values are shown as •••••••• and stay stored; leave
            them as they are, or type a new value over them.
          </p>
          <div className="spec-editor">
            <Suspense fallback={<p className="muted pad">Loading the editor…</p>}>
              <JsonEditor value={content} onChange={(v) => { setContent(v); setPreview(null) }} language={isJson ? 'json' : 'yaml'} />
            </Suspense>
          </div>

          {preview && (
            <div className="spec-preview">
              <p className="field-label">If you update now</p>
              <ul className="plain-list">
                {preview.requests.map((r) => (
                  <li key={r.key}>
                    <span className={`tag method method-${r.method.toLowerCase()}`}>{r.method}</span> {r.name}{' '}
                    <span className="muted small">({r.fieldCount} field{r.fieldCount === 1 ? '' : 's'})</span>{' '}
                    {r.exists ? <span className="tag">Update</span> : <span className="badge badge-ok">New</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="form-actions">
            <button className="btn" onClick={() => void check()} disabled={busy !== null}>
              {busy === 'check' ? <span className="spinner" /> : null} Check changes
            </button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy !== null}>
              {busy === 'save' ? <span className="spinner" /> : <Icon name="check" size={16} />} Save and update forms
            </button>
            {changed && <button className="btn btn-quiet" onClick={() => void discard()}>Discard changes</button>}
          </div>
        </>
      )}
    </section>
  )
}
