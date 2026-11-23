import { createContext } from 'react'
import type { GridColumn } from './array-grid'

/** Shared by a lines grid and its rows: which line is selected and where its details go. */
export interface LinesState {
  columns: GridColumn[]
  rows: unknown[]
  rowErrors: boolean[]
  selected: number
  select: (index: number, focusRow?: boolean) => void
  detailsEl: HTMLElement | null
  title: string
}

export const LinesContext = createContext<LinesState | null>(null)
