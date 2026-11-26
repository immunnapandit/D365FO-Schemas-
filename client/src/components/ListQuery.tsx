import type { ODataCondition, ODataField, ODataList, ODataQueryInput } from '../lib/types'
import Icon from './Icon'

/**
 * Filters of a list form on an OData entity (customers, vendors, sales orders…): field, condition and value per row,
 * company, sort and number of rows. The server turns them into $filter / $orderby / $top.
 */

const OPS: Record<string, { op: string; label: string }[]> = {
  string: [
    { op: 'eq', label: 'is' },
    { op: 'ne', label: 'is not' },
    { op: 'contains', label: 'contains' },
    { op: 'startswith', label: 'starts with' },
    { op: 'endswith', label: 'ends with' },
  ],
  number: [
    { op: 'eq', label: '=' },
    { op: 'ne', label: '≠' },
    { op: 'gt', label: '>' },
    { op: 'ge', label: '≥' },
    { op: 'lt', label: '<' },
    { op: 'le', label: '≤' },
    { op: 'between', label: 'between' },
  ],
  date: [
    { op: 'eq', label: 'on' },
    { op: 'ge', label: 'on or after' },
    { op: 'le', label: 'on or before' },
    { op: 'gt', label: 'after' },
    { op: 'lt', label: 'before' },
    { op: 'between', label: 'from … to' },
  ],
  enum: [
    { op: 'eq', label: 'is' },
    { op: 'ne', label: 'is not' },
  ],
}

const typeOf = (f?: ODataField) => f?.type ?? 'string'

function ValueInput({ field, value, onChange, label }: { field?: ODataField; value?: string; onChange: (v: string) => void; label: string }) {
  const t = typeOf(field)
  if (t === 'enum' && field?.options?.length) {
    return (
      <select className="form-control" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  return (
    <input className="form-control" aria-label={label} type={t === 'date' ? 'date' : t === 'number' ? 'number' : 'text'}
      value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
  )
}

export default function ListQuery({ odata, value, onChange, disabled }: {
  odata: ODataList; value: ODataQueryInput; onChange: (q: ODataQueryInput) => void; disabled?: boolean
}) {
  const fields = odata.fields
  const byName = new Map(fields.map((f) => [f.name, f]))
  const set = (patch: Partial<ODataQueryInput>) => onChange({ ...value, ...patch })
  const setRow = (i: number, patch: Partial<ODataCondition>) => set({ filters: value.filters.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const add = () => {
    const used = new Set(value.filters.map((f) => f.field))
    const f = fields.find((x) => !used.has(x.name)) ?? fields[0]
    if (f) set({ filters: [...value.filters, { field: f.name, op: OPS[typeOf(f)][0].op, value: '' }] })
  }
  const title = (f?: ODataField) => f?.title || f?.name || ''

  return (
    <fieldset className="list-query" disabled={disabled}>
      <legend><Icon name="filter" size={16} /> Filters</legend>
      <div className="lq-top">
        {odata.company && (
          <label className="lq-field">
            <span>Company</span>
            <input className="form-control" value={value.company ?? ''} placeholder="All companies you can see" maxLength={10}
              onChange={(e) => set({ company: e.target.value })} />
          </label>
        )}
        <label className="lq-field">
          <span>Sort by</span>
          <select className="form-control" value={value.orderBy ?? ''} onChange={(e) => set({ orderBy: e.target.value || undefined })}>
            <option value="">As the system returns them</option>
            {fields.map((f) => <option key={f.name} value={f.name}>{title(f)}</option>)}
          </select>
        </label>
        <label className="lq-check">
          <input type="checkbox" checked={!!value.desc} onChange={(e) => set({ desc: e.target.checked })} disabled={!value.orderBy} />
          <span>Newest / highest first</span>
        </label>
        <label className="lq-field lq-rows">
          <span>Rows</span>
          <input className="form-control" type="number" min={1} max={odata.maxTop ?? 10000} value={value.top ?? ''}
            onChange={(e) => set({ top: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </label>
      </div>

      {value.filters.length > 0 && (
        <ul className="lq-rows-list">
          {value.filters.map((r, i) => {
            const f = byName.get(r.field)
            const ops = OPS[typeOf(f)] ?? OPS.string
            const n = i + 1
            return (
              <li key={i} className="lq-row">
                <span className="lq-and">{i === 0 ? 'Where' : 'and'}</span>
                <select className="form-control" aria-label={`Filter ${n}: field`} value={r.field}
                  onChange={(e) => {
                    const nf = byName.get(e.target.value)
                    setRow(i, { field: e.target.value, op: OPS[typeOf(nf)][0].op, value: '', value2: undefined })
                  }}>
                  {fields.map((x) => <option key={x.name} value={x.name}>{title(x)}</option>)}
                </select>
                <select className="form-control lq-op" aria-label={`Filter ${n}: condition`} value={r.op}
                  onChange={(e) => setRow(i, { op: e.target.value, value2: e.target.value === 'between' ? r.value2 : undefined })}>
                  {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                </select>
                <ValueInput field={f} value={r.value} label={`Filter ${n}: value`} onChange={(v) => setRow(i, { value: v })} />
                {r.op === 'between' && (
                  <>
                    <span className="lq-and">and</span>
                    <ValueInput field={f} value={r.value2} label={`Filter ${n}: second value`} onChange={(v) => setRow(i, { value2: v })} />
                  </>
                )}
                <button type="button" className="btn btn-quiet btn-icon btn-danger-quiet" aria-label={`Remove filter ${n}`} title="Remove"
                  onClick={() => set({ filters: value.filters.filter((_, j) => j !== i) })}>
                  <Icon name="x" size={14} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <button type="button" className="btn btn-sm" onClick={add} disabled={!fields.length}>
        <Icon name="plus" /> Add filter
      </button>
      {value.filters.length === 0 && <span className="lq-hint">No filter: the first {value.top ?? 100} records are loaded.</span>}
    </fieldset>
  )
}
