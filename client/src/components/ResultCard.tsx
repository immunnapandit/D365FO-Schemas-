import { useState } from 'react'
import type { ExecuteResult } from '../lib/types'
import Icon from './Icon'
import DataGrid from './DataGrid'

/**
 * What happened to a submission, as the three things the server does in order:
 * check the input, sign in to the target system, call the API.
 */

type StepState = 'done' | 'failed' | 'skipped' | 'waiting' | 'running'

const HEADLINE: Record<string, string> = {
  config: 'The form is not set up correctly',
  validation: 'Some fields need attention',
  auth: 'Sign-in to the target system failed',
  api: 'The target system rejected the request',
  network: 'The target system could not be reached',
  server: 'The request could not be completed',
}

function failedStep(r: ExecuteResult): number {
  switch (r.stage) {
    case 'validation': return 0
    case 'auth': return 1
    case 'api': return 2
    case 'config':
    case 'network': return r.auth ? 2 : 1
    default: return -1
  }
}

export function Pipeline({ result, running, authType }: { result: ExecuteResult | null; running?: boolean; authType?: string }) {
  const noAuth = (result?.auth?.type ?? authType) === 'none'
  const failed = result && !result.ok ? failedStep(result) : -1
  const state = (i: number): StepState => {
    if (running) return 'running'
    if (!result) return 'waiting'
    if (i === 1 && noAuth && failed !== 1) return 'skipped'
    if (result.ok) return 'done'
    if (failed === -1) return 'waiting'
    return i < failed ? 'done' : i === failed ? 'failed' : 'waiting'
  }
  const ms = (n?: number) => (n !== undefined ? `${n} ms` : '')
  const steps = [
    { label: 'Check the input', note: '' },
    {
      label: 'Sign in to the target system',
      note: noAuth ? 'Not needed' : result?.auth?.cached ? 'Token reused' : ms(result?.timings?.authMs),
    },
    { label: 'Call the API', note: result?.status ? `HTTP ${result.status}${result.timings?.apiMs !== undefined ? `, ${result.timings.apiMs} ms` : ''}` : '' },
  ]
  return (
    <ol className="pipeline" aria-label="Submission steps">
      {steps.map((s, i) => {
        const st = state(i)
        return (
          <li key={s.label} className={`step step-${st}`}>
            <span className="step-mark" aria-hidden="true">
              {st === 'done' && <Icon name="check" size={14} />}
              {st === 'failed' && <Icon name="x" size={14} />}
              {st === 'skipped' && <Icon name="minus" size={14} />}
              {st === 'running' && <span className="spinner" />}
            </span>
            <span className="step-text">
              <span className="step-label">{s.label}</span>
              {(st === 'done' || st === 'skipped' || (st === 'failed' && i === 2)) && s.note && <span className="step-note">{s.note}</span>}
              <span className="sr-only">
                {st === 'done' ? 'completed' : st === 'failed' ? 'failed' : st === 'skipped' ? 'skipped' : st === 'running' ? 'in progress' : 'not reached'}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Json({ title, value }: { title: string; value: unknown }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <details className="json-block">
      <summary>{title}</summary>
      <pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
    </details>
  )
}

type Row = Record<string, unknown>
const isRecord = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** OData collections ({ value: [...] }) and arrays of records */
function listOf(value: unknown): { rows: Row[]; total?: number; more: boolean } | null {
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.value) ? value.value : null
  if (!list || !list.every(isRecord)) return null
  const count = isRecord(value) ? Number(value['@odata.count']) : NaN
  return { rows: list as Row[], total: Number.isFinite(count) ? count : undefined, more: isRecord(value) && typeof value['@odata.nextLink'] === 'string' }
}

function ResponseTable({ value, fileName }: { value: unknown; fileName: string }) {
  const list = listOf(value)
  if (list) return <DataGrid rows={list.rows} total={list.total} more={list.more} fileName={fileName} />
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([k]) => !k.startsWith('@'))
    return (
      <div className="table-scroll">
        <table className="data-table kv-table">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{v && typeof v === 'object' ? <pre className="cell-json">{JSON.stringify(v, null, 2)}</pre> : cell(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return <pre className="plain-pre">{cell(value)}</pre>
}

function ResponseView({ value, title, fileName }: { value: unknown; title: string; fileName: string }) {
  const [mode, setMode] = useState<'table' | 'json'>('table')
  if (value === undefined || value === null || value === '') return null
  const tabular = typeof value === 'object'
  return (
    <section className="response-view">
      <div className="response-head">
        <h3>{title}</h3>
        {tabular && (
          <div className="segmented" role="group" aria-label="Show the response as">
            <button className={mode === 'table' ? 'on' : ''} aria-pressed={mode === 'table'} onClick={() => setMode('table')}>Table</button>
            <button className={mode === 'json' ? 'on' : ''} aria-pressed={mode === 'json'} onClick={() => setMode('json')}>JSON</button>
          </div>
        )}
      </div>
      {tabular && mode === 'table' ? <ResponseTable value={value} fileName={fileName} /> : (
        <pre className="json-pre">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
      )}
    </section>
  )
}

function LinesSummary({ lines }: { lines: NonNullable<ExecuteResult['lines']> }) {
  return (
    <section className="lines-result">
      <h3>Lines</h3>
      <ol>
        {lines.map((l) => (
          <li key={l.index} className={l.ok ? 'ok' : 'err'}>
            <Icon name={l.ok ? 'check' : 'x'} size={14} /> Line {l.index + 1}: {l.ok ? `created (HTTP ${l.status})` : l.message}
          </li>
        ))}
      </ol>
    </section>
  )
}

export default function ResultCard({ result, onClose, authType, name = 'records' }: { result: ExecuteResult; onClose?: () => void; authType?: string; name?: string }) {
  const ok = result.ok
  return (
    <section className={`result ${ok ? 'result-ok' : 'result-err'}`} role={ok ? 'status' : 'alert'}>
      <header className="result-head">
        <h2>{ok ? 'Submitted' : HEADLINE[result.stage ?? 'server'] ?? 'The request failed'}</h2>
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="Close result">
            <Icon name="x" size={16} />
          </button>
        )}
      </header>

      <p className="result-message">{result.message}</p>
      {!!result.details?.length && (
        <ul className="result-details">
          {result.details.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      )}

      <Pipeline result={result} authType={authType} />

      {!!result.lines?.length && <LinesSummary lines={result.lines} />}
      {ok && <ResponseView title="Response" value={result.response} fileName={name} />}
      <Json title="Request sent" value={result.request} />
      {!ok && <Json title="Error response received" value={result.response} />}

      {!ok && result.requestId && (
        <p className="support-id">
          Quote this reference if you contact support: <code>{result.requestId}</code>
        </p>
      )}
    </section>
  )
}
