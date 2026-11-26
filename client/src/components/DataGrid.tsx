import { useMemo, useState } from 'react'
import { downloadXlsx } from '../lib/xlsx'
import Icon from './Icon'

/**
 * Records returned by an API (an OData list, an array), as a read-only grid: all columns, scroll sideways,
 * sort by a column, search, pages of 100, and Export to Excel.
 */

type Row = Record<string, unknown>
const PAGE = 100

/** D365 writes "no date" as 1900-01-01 */
const NO_DATE = /^1900-01-01T00:00:00(\.0+)?Z$/

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return NO_DATE.test(v) ? '' : v
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function columnsOf(rows: Row[]): string[] {
  const seen = new Set<string>()
  for (const r of rows.slice(0, 500)) for (const k of Object.keys(r)) if (!k.startsWith('@')) seen.add(k)
  return [...seen]
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true, sensitivity: 'base' })
}

export default function DataGrid({ rows, total, more, fileName }: { rows: Row[]; total?: number; more?: boolean; fileName: string }) {
  const columns = useMemo(() => columnsOf(rows), [rows])
  const numeric = useMemo(
    () => new Set(columns.filter((c) => rows.slice(0, 50).some((r) => typeof r[c] === 'number') && rows.every((r) => r[c] == null || typeof r[c] === 'number'))),
    [columns, rows],
  )
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null)
  const [page, setPage] = useState(0)

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = q ? rows.filter((r) => columns.some((c) => cellText(r[c]).toLowerCase().includes(q))) : rows
    if (sort) list = [...list].sort((a, b) => (sort.desc ? -1 : 1) * compare(a[sort.col], b[sort.col]))
    return list
  }, [rows, columns, search, sort])

  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const current = Math.min(page, pages - 1)
  const slice = shown.slice(current * PAGE, current * PAGE + PAGE)

  const sortBy = (col: string) => {
    setSort((s) => (s?.col === col ? (s.desc ? null : { col, desc: true }) : { col, desc: false }))
    setPage(0)
  }
  const exportExcel = () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const data = shown.map((r) => Object.fromEntries(columns.map((c) => [c, typeof r[c] === 'number' ? r[c] : cellText(r[c])])))
    downloadXlsx(`${fileName.replace(/[^\w\- ]+/g, '').trim() || 'records'} ${stamp}`, columns, data, fileName)
  }

  if (!rows.length) return <p className="muted">No records returned.</p>

  return (
    <div className="dg">
      <div className="dg-bar">
        <span className="dg-count">
          {search.trim() ? `${shown.length} of ${rows.length} records` : `${rows.length} record${rows.length === 1 ? '' : 's'}`}
          {total !== undefined && total > rows.length && !search.trim() && <span className="muted"> (of {total} in the system)</span>}
        </span>
        <label className="dg-search">
          <Icon name="search" size={14} />
          <span className="sr-only">Search the records</span>
          <input type="search" placeholder="Search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} />
        </label>
        <button type="button" className="btn btn-sm" onClick={exportExcel} disabled={!shown.length}>
          <Icon name="download" size={14} /> Export to Excel
        </button>
      </div>
      {(more || (total !== undefined && total > rows.length)) && (
        <p className="dg-note">More records match than were loaded. Raise <b>Rows</b> or narrow the filters to see them.</p>
      )}
      <div className="dg-scroll">
        <table className="dg-table" aria-rowcount={shown.length + 1}>
          <thead>
            <tr>
              <th className="dg-no" scope="col">#</th>
              {columns.map((c) => (
                <th key={c} scope="col" className={numeric.has(c) ? 'num' : undefined}
                  aria-sort={sort?.col === c ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                  <button type="button" onClick={() => sortBy(c)} title={`Sort by ${c}`}>
                    {c}
                    {sort?.col === c && <Icon name={sort.desc ? 'down' : 'up'} size={12} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={current * PAGE + i}>
                <th className="dg-no" scope="row">{current * PAGE + i + 1}</th>
                {columns.map((c) => {
                  const t = cellText(r[c])
                  return <td key={c} className={numeric.has(c) ? 'num' : undefined} title={t.length > 30 ? t : undefined}>{t}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="dg-empty">No record contains “{search}”.</p>}
      </div>
      {pages > 1 && (
        <div className="dg-pages">
          <button type="button" className="btn btn-sm" onClick={() => setPage(current - 1)} disabled={current === 0}>Previous</button>
          <span>Page {current + 1} of {pages}</span>
          <button type="button" className="btn btn-sm" onClick={() => setPage(current + 1)} disabled={current >= pages - 1}>Next</button>
        </div>
      )}
    </div>
  )
}
