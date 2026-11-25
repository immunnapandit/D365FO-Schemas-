import { orderProperties } from '@rjsf/utils'
import type { RJSFSchema, UiSchema } from '@rjsf/utils'

/**
 * Lists in a form are edited as a grid, as in D365 F&O: one row per line and one column per field, typed in place.
 * Fields of an object inside a line (customer → name, city) get a column each; a list inside a line (the items of an
 * invoice) gets a column with its count and opens as its own grid under the line.
 */

export type ColumnKind = 'text' | 'number' | 'bool' | 'date' | 'choice' | 'long' | 'list'

export interface GridColumn {
  /** path inside the line, e.g. "customer.name" ("" for a list of single values) */
  key: string
  title: string
  /** title of the object the field is in, shown above the field title */
  group?: string
  required: boolean
  kind: ColumnKind
  width: number
}

export type ListLayout = { mode: 'grid'; columns: GridColumn[] } | { mode: 'cards' }

const WIDTH: Record<ColumnKind, number> = { text: 168, number: 118, bool: 76, date: 150, choice: 150, long: 240, list: 128 }

const asSchema = (s: unknown): RJSFSchema | undefined => (s && typeof s === 'object' && !Array.isArray(s) ? (s as RJSFSchema) : undefined)
const typeOf = (s: RJSFSchema): string | undefined => {
  const t = s.type
  if (Array.isArray(t)) return t.find((x) => x !== 'null') as string | undefined
  return t as string | undefined
}

/** forms the grid cannot show cell by cell: they stay as cards */
function unsupported(s: RJSFSchema): boolean {
  return Boolean(s.oneOf || s.anyOf || s.dependencies || s.if || s.additionalProperties === true || s.$ref)
}

function kindOf(s: RJSFSchema, ui: UiSchema | undefined): ColumnKind {
  const widget = ui?.['ui:widget']
  if (widget === 'textarea') return 'long'
  const t = typeOf(s)
  if (t === 'array') {
    const items = asSchema(s.items)
    // a multi-select (enum items, unique) is one widget, not a list
    return items?.enum && s.uniqueItems ? 'long' : 'list'
  }
  if (s.enum) return 'choice'
  if (t === 'boolean') return 'bool'
  if (t === 'number' || t === 'integer') return 'number'
  if (s.format === 'date' || s.format === 'date-time') return 'date'
  return 'text'
}

function walk(s: RJSFSchema, ui: UiSchema | undefined, prefix: string, group: string | undefined, required: boolean, out: GridColumn[]): boolean {
  const props = s.properties as Record<string, unknown> | undefined
  if (!props) return true
  const req = new Set(s.required ?? [])
  let keys: string[]
  try {
    keys = orderProperties(Object.keys(props), ui?.['ui:order'] as string[] | undefined)
  } catch {
    keys = Object.keys(props)
  }
  for (const k of keys) {
    const p = asSchema(props[k])
    if (!p) continue
    const pu = asSchema((ui as Record<string, unknown> | undefined)?.[k]) as UiSchema | undefined
    if (pu?.['ui:widget'] === 'hidden') continue
    if (unsupported(p)) return false
    const key = prefix ? `${prefix}.${k}` : k
    const title = String(p.title || k)
    if (typeOf(p) === 'object' || (p.properties && !p.type)) {
      if (!walk(p, pu, key, group ? `${group} › ${title}` : title, required && req.has(k), out)) return false
      continue
    }
    const kind = kindOf(p, pu)
    out.push({ key, title, group, required: req.has(k), kind, width: WIDTH[kind] })
  }
  return true
}

/** The columns of a list's grid, or cards when a line is not a plain record. `ui:options.columnWidths` sets widths. */
export function listLayout(itemSchema: unknown, itemUi?: UiSchema, listUi?: UiSchema): ListLayout {
  const s = asSchema(itemSchema)
  if (!s || unsupported(s)) return { mode: 'cards' }
  const t = typeOf(s)
  const columns: GridColumn[] = []
  if (t === 'object' || s.properties) {
    if (!s.properties || !Object.keys(s.properties).length) return { mode: 'cards' }
    if (!walk(s, itemUi, '', undefined, true, columns) || !columns.length) return { mode: 'cards' }
  } else if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean') {
    const kind = kindOf(s, itemUi)
    columns.push({ key: '', title: String(s.title || 'Value'), required: true, kind, width: Math.max(WIDTH[kind], 220) })
  } else {
    return { mode: 'cards' }
  }
  const widths = (listUi?.['ui:options'] as Record<string, unknown> | undefined)?.columnWidths as Record<string, number> | undefined
  if (widths) for (const c of columns) if (typeof widths[c.key] === 'number') c.width = widths[c.key]
  return { mode: 'grid', columns }
}

/** CSS grid columns: line number, the fields (wider when there is room), the row tools. */
export function gridTemplate(columns: GridColumn[]): string {
  return ['44px', ...columns.map((c) => `minmax(${c.width}px, ${c.width}fr)`), '76px'].join(' ')
}
