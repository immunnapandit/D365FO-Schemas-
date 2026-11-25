import type { RJSFSchema, UiSchema } from '@rjsf/utils'

const PRIMITIVE = new Set(['string', 'number', 'integer', 'boolean'])
/** Up to this many single-value fields (and no nested lists) a list is edited right in the table. */
const INLINE_MAX = 8
/** Columns shown in the lines grid; every other field is edited in "Line details". */
const KEY_COLUMNS = 6

export interface GridColumn { key: string; title: string; required: boolean; numeric: boolean; boolean: boolean }

export type ListLayout =
  | { mode: 'inline'; columns: GridColumn[] }
  | { mode: 'lines'; columns: GridColumn[]; fieldCount: number }
  | { mode: 'cards' }

function isPrimitive(s: unknown): boolean {
  if (!s || typeof s !== 'object') return false
  const t = (s as RJSFSchema).type
  return typeof t === 'string' && PRIMITIVE.has(t)
}

/**
 * Fields that identify a line, in the order a person reads one (as on a D365 order line).
 * Each group adds at most one column; within a group the earlier pattern wins.
 */
const LINE_NO = 0
/** Groups that name a document (its number and date): skipped for lines that have a line number. */
const DOCUMENT_GROUPS = new Set([1, 8])

const KEY_GROUPS: RegExp[][] = [
  [/^(line_?(no|num(ber)?)|lineno|linenum|s_?no|seq(uence)?(_?no)?)$/i],
  [/^(doc|document|order|invoice|inv|po|so|bill|voucher|journal|purchase|sales)_?(no|num(ber)?|id)$/i, /^(irn|id|code|number)$/i],
  [/hsn|sac/i],
  [/^(item|product|article|art|material|sku)_?(id|no|nbr|num(ber)?|code)$/i, /^(item|product|article|material|sku)$/i],
  [/^(item|article|art|product)_?name$/i, /(desc|description)$/i, /^(supp?|supplier|vendor|cust|customer|party|buyer|seller)_?name$/i, /^(?!.*file).*name$/i],
  [/(qty|quantity)$/i],
  [/(unit_?price|price)$/i, /price_?(mrp|rtl|retail|sale|sales)$/i],
  [/taxable_?val(ue)?$|net_?amount$|line_?amount$|line_?item_?amt$|total(_?amount)?$/i, /(amount|amt)$/i],
  [/^(doc|document|order|invoice|inv|posting|transaction|trans)_?date$/i],
]

function column(s: RJSFSchema, key: string, required: Set<string>): GridColumn {
  const p = (s.properties as Record<string, RJSFSchema>)[key]
  return {
    key,
    title: p.title || key,
    required: required.has(key),
    numeric: p.type === 'number' || p.type === 'integer',
    boolean: p.type === 'boolean',
  }
}

function ordered(keys: string[], itemUi?: UiSchema): string[] {
  const order = itemUi?.['ui:order'] as string[] | undefined
  if (!order) return keys
  return order.filter((k) => keys.includes(k) || k === '*').flatMap((k) => (k === '*' ? keys.filter((x) => !order.includes(x)) : [k]))
}

/** The columns to show for a long line: required fields first, then the usual line identifiers. */
function keyColumns(keys: string[], required: Set<string>, numeric: Set<string>, preferred?: unknown): string[] {
  if (Array.isArray(preferred) && preferred.length) return preferred.filter((k): k is string => typeof k === 'string' && keys.includes(k))
  const picked = new Set<string>()
  const take = (k?: string) => { if (k && picked.size < KEY_COLUMNS) picked.add(k) }
  // the first field usually identifies a line, unless it is one of a run of numbers (size_010, size_020, ...)
  if (keys[0] && !numeric.has(keys[0])) take(keys[0])
  keys.filter((k) => required.has(k)).forEach(take)
  const isLine = keys.some((k) => KEY_GROUPS[LINE_NO].some((re) => re.test(k)))
  for (const [g, group] of KEY_GROUPS.entries()) {
    if (isLine && DOCUMENT_GROUPS.has(g)) continue
    for (const re of group) {
      const hit = keys.find((k) => re.test(k) && !picked.has(k))
      if (hit) { take(hit); break }
    }
  }
  keys.filter((k) => !numeric.has(k)).forEach(take) // text fields (codes, names) say more than numbers
  keys.forEach(take)
  return keys.filter((k) => picked.has(k)) // keep the file's order, it is the order people know
}

/**
 * How a list of rows is shown in a form:
 * - inline: few single-value fields (e.g. sales order lines with item, qty, price) → edited right in the table
 * - lines:  many fields or a list inside each row (e.g. GST invoices) → a lines grid with the key columns,
 *           and every field of the selected line in "Line details" below it (as in D365 F&O)
 * - cards:  rows that are not objects
 * `ui:options.gridColumns` on the list picks the grid columns.
 */
export function listLayout(itemSchema: unknown, itemUi?: UiSchema, listUi?: UiSchema): ListLayout {
  const s = itemSchema as RJSFSchema | undefined
  if (!s || s.type !== 'object' || !s.properties || s.additionalProperties === true) return { mode: 'cards' }
  const all = Object.keys(s.properties)
  const simple = all.filter((k) => isPrimitive((s.properties as Record<string, unknown>)[k]))
  if (simple.length === 0) return { mode: 'cards' }
  const required = new Set(s.required ?? [])
  const keys = ordered(simple, itemUi)
  if (simple.length === all.length && simple.length <= INLINE_MAX) {
    return { mode: 'inline', columns: keys.map((k) => column(s, k, required)) }
  }
  const preferred = (listUi?.['ui:options'] as Record<string, unknown> | undefined)?.gridColumns
  const numeric = new Set(keys.filter((k) => column(s, k, required).numeric))
  return { mode: 'lines', columns: keyColumns(keys, required, numeric, preferred).map((k) => column(s, k, required)), fieldCount: all.length }
}

/** A cell value as shown in the lines grid. */
export function cellText(v: unknown, col: GridColumn): string {
  if (v === undefined || v === null || v === '') return ''
  if (col.boolean) return v ? 'Yes' : 'No'
  return String(v)
}
