import type { ExecuteResult } from '../lib/types'
import Icon from './Icon'

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
              {st !== 'waiting' && st !== 'running' && s.note && <span className="step-note">{s.note}</span>}
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

export default function ResultCard({ result, onClose, authType }: { result: ExecuteResult; onClose?: () => void; authType?: string }) {
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

      <Json title="Request sent" value={result.request} />
      <Json title={ok ? 'Response received' : 'Error response received'} value={result.response} />

      {!ok && result.requestId && (
        <p className="support-id">
          Quote this reference if you contact support: <code>{result.requestId}</code>
        </p>
      )}
    </section>
  )
}
