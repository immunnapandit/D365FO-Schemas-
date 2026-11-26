import type { ODataList, ODataQueryInput } from './types'

/** The filters of a list form before the user changes anything: no filter, the form's rows and sort. */
export const emptyQuery = (o: ODataList): ODataQueryInput => ({ filters: [], top: o.top ?? 100, orderBy: o.orderBy })
