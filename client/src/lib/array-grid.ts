import type { RJSFSchema, UiSchema } from '@rjsf/utils'

const MAX_COLUMNS = 12
const PRIMITIVE = new Set(['string', 'number', 'integer', 'boolean'])

export interface GridColumn { key: string; title: string; required: boolean }

function isPrimitive(s: unknown): boolean {
  if (!s || typeof s !== 'object') return false
  const t = (s as RJSFSchema).type
  return typeof t === 'string' && PRIMITIVE.has(t)
}

/**
 * Columns for a list whose rows are flat objects (one value per field), e.g. invoice lines.
 * Returns null when the rows are nested or too wide, so the list falls back to row cards.
 */
export function gridColumns(itemSchema: unknown, itemUi?: UiSchema): GridColumn[] | null {
  const s = itemSchema as RJSFSchema | undefined
  if (!s || s.type !== 'object' || !s.properties || s.additionalProperties === true) return null
  const keys = Object.keys(s.properties)
  if (keys.length === 0 || keys.length > MAX_COLUMNS) return null
  if (!keys.every((k) => isPrimitive((s.properties as Record<string, unknown>)[k]))) return null
  const order = itemUi?.['ui:order'] as string[] | undefined
  const sorted = order
    ? order.filter((k) => keys.includes(k) || k === '*').flatMap((k) => (k === '*' ? keys.filter((x) => !order.includes(x)) : [k]))
    : keys
  const required = new Set(s.required ?? [])
  return sorted.map((key) => {
    const p = (s.properties as Record<string, RJSFSchema>)[key]
    return { key, title: p.title || key, required: required.has(key) }
  })
}
