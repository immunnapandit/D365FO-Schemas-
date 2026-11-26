import type { ODataList, ODataQueryInput } from './types'

/** The filters of a list form before the user changes anything: the form's starting filters, company, rows and sort. */
export const emptyQuery = (o: ODataList): ODataQueryInput => ({
  filters: (o.filters ?? []).map((f) => ({ field: f.field, op: f.op ?? 'eq', value: f.value ?? '', ...(f.value2 ? { value2: f.value2 } : {}) })),
  company: o.defaultCompany,
  top: o.top ?? 100,
  orderBy: o.orderBy,
})
