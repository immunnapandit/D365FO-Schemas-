import { useId, useState, type ReactNode } from 'react'
import Icon from './Icon'

/** Small labelled inputs shared by the form designer and the module settings. */

const MASK = '••••••••'

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; wide?: boolean }) {
  const id = useId()
  return (
    <div className={`field ${wide ? 'field-wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}

export function Text(props: {
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
export function JsonText({ label, value, onChange, hint, rows = 6 }: {
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

export function Pairs({ label, value, onChange, keyLabel, valueLabel }: {
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

export const SecretHint = () => (
  <>Use <code>{'{{kv:secret-name}}'}</code> to read it from Key Vault. A value typed here is stored encrypted.</>
)

