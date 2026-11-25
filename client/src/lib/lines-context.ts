import { createContext } from 'react'
import type { GridColumn } from './array-grid'

/**
 * Set by a grid row for the fields of its line: they render as cells of the row instead of labelled fields.
 * Lists inside the line open their own grid in `subEl`, the full-width area under the row.
 */
export interface GridRowState {
  /** the path of the line in the form data, e.g. ["req", 0] */
  path: (string | number)[]
  /** column index (from 0) of each field path inside the line */
  columnOf: Map<string, number>
  columns: GridColumn[]
  subEl: HTMLElement | null
  /** lists inside this line that are open under it */
  open: Set<string>
  toggle: (key: string) => void
}

export const GridRowContext = createContext<GridRowState | null>(null)
