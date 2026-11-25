import type { FormSummary } from './types'

export const UNGROUPED = 'Other forms'

/** Forms grouped by module, modules in alphabetical order, ungrouped forms last. */
export function groupByModule(forms: FormSummary[]): [string, FormSummary[]][] {
  const groups = new Map<string, FormSummary[]>()
  for (const f of forms) {
    const key = f.category?.trim() || UNGROUPED
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  return [...groups.entries()].sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)))
}

/** Forms of one module split by group (Postman folder, OpenAPI tag): forms without a group first, then groups A-Z. */
export function groupInModule(forms: FormSummary[]): { group: string | null; forms: FormSummary[] }[] {
  const loose = forms.filter((f) => !f.group?.trim())
  const byGroup = new Map<string, FormSummary[]>()
  for (const f of forms) {
    const g = f.group?.trim()
    if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), f])
  }
  const named = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, list]) => ({ group, forms: list }))
  return loose.length ? [{ group: null, forms: loose }, ...named] : named
}
