import type { RJSFSchema, UiSchema } from '@rjsf/utils'

/**
 * The Fields tab edits a flat list of fields. These helpers convert between that list
 * and the stored JSON Schema + uiSchema. Schemas that use nested objects, arrays or
 * conditions cannot be shown as a flat list and are edited on the JSON tab instead.
 */

export type FieldKind = 'text' | 'textarea' | 'number' | 'integer' | 'checkbox' | 'date' | 'datetime' | 'email' | 'dropdown'

export const FIELD_KINDS: { value: FieldKind; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Whole number' },
  { value: 'checkbox', label: 'Yes / No' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date and time' },
  { value: 'email', label: 'Email' },
  { value: 'dropdown', label: 'Dropdown' },
]

export interface DesignField {
  /** stable id for React lists */
  uid: string
  key: string
  label: string
  kind: FieldKind
  required: boolean
  defaultValue: string
  options: string
  placeholder: string
  help: string
  /** JSON Schema keywords we do not edit but must keep (minLength, pattern, …) */
  extra: Record<string, unknown>
  uiExtra: Record<string, unknown>
}

let counter = 0
const uid = () => `f${Date.now().toString(36)}${(counter++).toString(36)}`

export function newField(existingKeys: string[]): DesignField {
  let n = existingKeys.length + 1
  while (existingKeys.includes(`Field${n}`)) n += 1
  return {
    uid: uid(), key: `Field${n}`, label: '', kind: 'text', required: false,
    defaultValue: '', options: '', placeholder: '', help: '', extra: {}, uiExtra: {},
  }
}

const HANDLED = ['type', 'title', 'default', 'enum', 'format']
const UI_HANDLED = ['ui:placeholder', 'ui:help', 'ui:widget']

function kindOf(prop: Record<string, unknown>, ui: Record<string, unknown>): FieldKind | null {
  if (Array.isArray(prop.enum)) return prop.enum.every((v) => typeof v === 'string' || typeof v === 'number') ? 'dropdown' : null
  switch (prop.type) {
    case 'string':
      if (prop.format === 'date') return 'date'
      if (prop.format === 'date-time') return 'datetime'
      if (prop.format === 'email') return 'email'
      if (prop.format) return null
      return ui['ui:widget'] === 'textarea' ? 'textarea' : 'text'
    case 'number':
      return 'number'
    case 'integer':
      return 'integer'
    case 'boolean':
      return 'checkbox'
    default:
      return null
  }
}

/** Returns the field list, or null when the schema needs the JSON tab. */
export function toFields(schema: RJSFSchema | undefined, uiSchema: UiSchema | undefined): DesignField[] | null {
  if (!schema || schema.type !== 'object') return null
  const blocked = ['allOf', 'anyOf', 'oneOf', 'if', 'dependencies', 'patternProperties', '$ref', 'definitions', '$defs']
  if (blocked.some((k) => k in schema)) return null
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const ui = (uiSchema ?? {}) as Record<string, unknown>
  const required = Array.isArray(schema.required) ? schema.required : []

  const order = Array.isArray(ui['ui:order']) ? (ui['ui:order'] as string[]) : []
  const keys = [...order.filter((k) => k in props), ...Object.keys(props).filter((k) => !order.includes(k))]

  const fields: DesignField[] = []
  for (const key of keys) {
    const prop = props[key]
    if (!prop || typeof prop !== 'object') return null
    const fieldUi = (ui[key] && typeof ui[key] === 'object' ? ui[key] : {}) as Record<string, unknown>
    const kind = kindOf(prop, fieldUi)
    if (!kind) return null
    const widget = fieldUi['ui:widget']
    if (widget && !(widget === 'textarea' && kind === 'textarea')) return null
    fields.push({
      uid: uid(),
      key,
      label: typeof prop.title === 'string' ? prop.title : '',
      kind,
      required: required.includes(key),
      defaultValue: prop.default === undefined ? '' : String(prop.default),
      options: Array.isArray(prop.enum) ? prop.enum.join('\n') : '',
      placeholder: typeof fieldUi['ui:placeholder'] === 'string' ? fieldUi['ui:placeholder'] : '',
      help: typeof fieldUi['ui:help'] === 'string' ? fieldUi['ui:help'] : '',
      extra: Object.fromEntries(Object.entries(prop).filter(([k]) => !HANDLED.includes(k))),
      uiExtra: Object.fromEntries(Object.entries(fieldUi).filter(([k]) => !UI_HANDLED.includes(k))),
    })
  }
  return fields
}

function typedDefault(f: DesignField): unknown {
  const v = f.defaultValue.trim()
  if (v === '') return undefined
  if (f.kind === 'number' || f.kind === 'integer') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  if (f.kind === 'checkbox') return ['true', 'yes', '1'].includes(v.toLowerCase())
  return v
}

export function fromFields(
  fields: DesignField[],
  baseSchema: RJSFSchema | undefined,
  baseUi: UiSchema | undefined,
): { formSchema: RJSFSchema; uiSchema: UiSchema } {
  const properties: Record<string, unknown> = {}
  const ui: Record<string, unknown> = {}
  // keep root-level ui options (ui:submitButtonOptions …), drop per-field entries and order
  for (const [k, v] of Object.entries(baseUi ?? {})) if (k.startsWith('ui:') && k !== 'ui:order') ui[k] = v

  for (const f of fields) {
    const key = f.key.trim()
    if (!key) continue
    const prop: Record<string, unknown> = { ...f.extra }
    switch (f.kind) {
      case 'number': prop.type = 'number'; break
      case 'integer': prop.type = 'integer'; break
      case 'checkbox': prop.type = 'boolean'; break
      case 'date': prop.type = 'string'; prop.format = 'date'; break
      case 'datetime': prop.type = 'string'; prop.format = 'date-time'; break
      case 'email': prop.type = 'string'; prop.format = 'email'; break
      case 'dropdown':
        prop.type = 'string'
        prop.enum = f.options.split('\n').map((o) => o.trim()).filter(Boolean)
        if (!(prop.enum as string[]).length) delete prop.enum
        break
      default: prop.type = 'string'
    }
    if (f.label.trim()) prop.title = f.label.trim()
    const def = typedDefault(f)
    if (def !== undefined) prop.default = def
    properties[key] = prop

    const fieldUi: Record<string, unknown> = { ...f.uiExtra }
    if (f.placeholder.trim()) fieldUi['ui:placeholder'] = f.placeholder.trim()
    if (f.help.trim()) fieldUi['ui:help'] = f.help.trim()
    if (f.kind === 'textarea') fieldUi['ui:widget'] = 'textarea'
    if (Object.keys(fieldUi).length) ui[key] = fieldUi
  }

  const { properties: _p, required: _r, ...rest } = (baseSchema ?? {}) as Record<string, unknown>
  void _p
  void _r
  const required = fields.filter((f) => f.required && f.key.trim()).map((f) => f.key.trim())
  const formSchema = { ...rest, type: 'object', ...(required.length ? { required } : {}), properties } as RJSFSchema
  return { formSchema, uiSchema: ui as UiSchema }
}

/** Problems in the field list that would break the form. */
export function fieldProblems(fields: DesignField[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  fields.forEach((f, i) => {
    const key = f.key.trim()
    if (!key) problems.push(`Field ${i + 1} needs a field name.`)
    else if (seen.has(key)) problems.push(`The field name "${key}" is used more than once.`)
    seen.add(key)
    if (f.kind === 'dropdown' && !f.options.trim()) problems.push(`"${key || `Field ${i + 1}`}" is a dropdown with no options.`)
  })
  return problems
}
