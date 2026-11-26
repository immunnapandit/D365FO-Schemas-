import { useEffect, useRef, useState } from 'react'
import Form from '@rjsf/core'
import type { RJSFValidationError } from '@rjsf/utils'
import { validator } from '../lib/validator'
import { api, ApiError } from '../lib/api'
import { timeAgo, fullDate } from '../lib/format'
import type { CurrentUser, ExecuteResult, FormDefinition, ODataQueryInput } from '../lib/types'
import ListQuery from './ListQuery'
import { emptyQuery } from '../lib/odata'
import ResultCard, { Pipeline } from './ResultCard'
import ErrorBoundary from './ErrorBoundary'
import RunHistory from './RunHistory'
import Icon from './Icon'
import { formTemplates, withListOptions } from '../lib/form-templates'

// Plain-language messages instead of the validator's wording
function transformErrors(errors: RJSFValidationError[]) {
  return errors.map((e) => {
    if (e.name === 'required') return { ...e, message: 'Enter a value' }
    if (e.name === 'enum') return { ...e, message: 'Choose a value from the list' }
    if (e.name === 'format' && e.params?.format === 'date') return { ...e, message: 'Enter a valid date' }
    if (e.name === 'format' && e.params?.format === 'email') return { ...e, message: 'Enter a valid email address' }
    if (e.name === 'type') return { ...e, message: 'Enter a valid value' }
    return e
  })
}

interface Props {
  id: string
  user: CurrentUser
  onEdit: (def: FormDefinition) => void
  onDuplicate: (def: FormDefinition) => void
  onMissing: () => void
}

export default function FormRunner({ id, user, onEdit, onDuplicate, onMissing }: Props) {
  const [def, setDef] = useState<FormDefinition | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<'form' | 'history'>('form')
  const [formData, setFormData] = useState<Record<string, unknown>>({})
  const [resetKey, setResetKey] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ExecuteResult | null>(null)
  const [test, setTest] = useState<ExecuteResult | null>(null)
  const [runs, setRuns] = useState(0)
  const [query, setQuery] = useState<ODataQueryInput>({ filters: [] })
  const resultRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getForm(id)
      .then((d) => {
        if (cancelled) return
        setDef(d)
        if (d.api.odata) setQuery(emptyQuery(d.api.odata))
      })
      .catch((e: ApiError) => {
        if (cancelled) return
        if (e.status === 404) onMissing()
        else setLoadError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [id, onMissing])

  // bring the result into view
  useEffect(() => {
    if (result || submitting) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [result, submitting])

  async function submit(data: Record<string, unknown>) {
    if (submitting) return
    setSubmitting(true)
    setResult(null)
    setTest(null)
    try {
      setResult(await api.execute(id, def?.api.odata ? { ...data, $query: query } : data))
    } catch (e) {
      const err = e as ApiError
      setResult({ ok: false, stage: 'server', message: err.message, details: err.details, requestId: err.requestId })
    } finally {
      setSubmitting(false)
      setRuns((n) => n + 1)
    }
  }

  async function testConnection() {
    setTesting(true)
    setTest(null)
    try {
      setTest(await api.testAuth(id))
    } catch (e) {
      const err = e as ApiError
      setTest({ ok: false, stage: 'server', message: err.message, requestId: err.requestId })
    } finally {
      setTesting(false)
    }
  }

  function clear() {
    setFormData({})
    if (def?.api.odata) setQuery(emptyQuery(def.api.odata))
    setResult(null)
    setResetKey((k) => k + 1)
  }

  if (loadError) return <div className="page"><div className="banner banner-error">{loadError}</div></div>
  if (!def) return <div className="page"><div className="skeleton" aria-label="Loading the form" /></div>

  const authType = def.auth?.type ?? 'none'
  const hasFields = Object.keys((def.formSchema?.properties as object) ?? {}).length > 0
  const listUi = withListOptions(def.uiSchema)

  return (
    <div className="page">
      <header className="page-head">
        <span className="form-glyph large"><Icon name={def.icon} size={24} /></span>
        <div className="page-title">
          {def.category && <p className="crumb">{def.category}</p>}
          <h1>{def.name}</h1>
          {def.description && <p className="lede">{def.description}</p>}
        </div>
        {user.canEdit && (
          <div className="actions">
            {authType !== 'none' && (
              <button className="btn" onClick={testConnection} disabled={testing}>
                {testing ? 'Testing…' : 'Test authentication'}
              </button>
            )}
            <button className="btn" onClick={() => onDuplicate(def)}>Duplicate</button>
            <button className="btn btn-primary" onClick={() => onEdit(def)}>Edit form</button>
          </div>
        )}
      </header>

      {user.canEdit && (
        <dl className="facts">
          <div><dt>Request</dt><dd className="mono" title={def.api.url}>{(def.api.method || 'POST').toUpperCase()} {def.api.url}</dd></div>
          {authType === 'module' && <div><dt>Sign-in</dt><dd>From the module {def.category ? `“${def.category}”` : '(none chosen)'}</dd></div>}
          <div><dt>Last change</dt><dd title={fullDate(def.updatedAt)}>Version {def.version} by {def.updatedBy || 'unknown'}, {timeAgo(def.updatedAt)}</dd></div>
          {!!def.allowedRoles?.length && <div><dt>Visible to</dt><dd>{def.allowedRoles.join(', ')}</dd></div>}
        </dl>
      )}

      {test && (
        <div className={`banner ${test.ok ? 'banner-ok' : 'banner-error'}`} role="status">
          <div>
            <strong>{test.ok ? 'Authentication works' : 'Authentication failed'}</strong>
            <p>{test.ok ? 'A token was received from the target system. No request was sent to the API.' : test.message.replace(/^Sign-in failed: /, '')}</p>
            {!!test.details?.length && <ul>{test.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
          </div>
          <button className="icon-btn" onClick={() => setTest(null)} aria-label="Dismiss"><Icon name="x" size={16} /></button>
        </div>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'form'} className={tab === 'form' ? 'on' : ''} onClick={() => setTab('form')}>Form</button>
        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
      </div>

      {tab === 'form' ? (
        <>
          <section className="sheet">
            <ErrorBoundary resetKey={def.version}>
              <Form
                key={`${id}-${def.version}-${resetKey}`}
                schema={def.formSchema}
                uiSchema={listUi}
                validator={validator}
                templates={formTemplates}
                formData={formData}
                onChange={(e) => setFormData((e.formData ?? {}) as Record<string, unknown>)}
                onSubmit={(e) => submit((e.formData ?? {}) as Record<string, unknown>)}
                onError={() => undefined}
                showErrorList={false}
                transformErrors={transformErrors}
                noHtml5Validate
                focusOnFirstError
                disabled={submitting}
              >
                {def.api.odata && <ListQuery odata={def.api.odata} value={query} onChange={setQuery} disabled={submitting} />}
                {!hasFields && !def.api.odata && <p className="muted">This form has no fields. Submitting sends the request as it is.</p>}
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? 'Sending…' : def.api.odata ? 'Load records' : (def.api.method || 'POST').toUpperCase() === 'GET' ? 'Send request' : 'Submit'}
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={clear} disabled={submitting}>{def.api.odata ? 'Clear filters' : 'Clear form'}</button>
                </div>
              </Form>
            </ErrorBoundary>
          </section>
          <div ref={resultRef}>
            {submitting && (
              <section className="result result-busy" aria-live="polite">
                <header className="result-head"><h2>Submitting</h2></header>
                <Pipeline result={null} running authType={authType} />
              </section>
            )}
            {result && <ResultCard result={result} authType={authType} name={def.name} onClose={() => setResult(null)} />}
          </div>
        </>
      ) : (
        <RunHistory formId={id} user={user} refreshKey={runs} />
      )}
    </div>
  )
}
