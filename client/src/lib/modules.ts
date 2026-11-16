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
