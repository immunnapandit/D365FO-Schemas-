import { getDefaultRegistry } from '@rjsf/core'
import { buttonId, getUiOptions } from '@rjsf/utils'
import type {
  ArrayFieldItemTemplateProps, ArrayFieldTemplateProps, FieldTemplateProps, IconButtonProps, ObjectFieldTemplateProps, RJSFSchema,
} from '@rjsf/utils'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { gridTemplate, listLayout } from '../lib/array-grid'
import type { GridColumn } from '../lib/array-grid'
import { GridRowContext } from '../lib/lines-context'
import Icon from './Icon'

/**
 * Lists in a form are a grid, as in D365 F&O: a row per line, a column per field, every value typed in place,
 * a scroll bar under the grid when the lines are wide. A list inside a line opens as its own grid under the line.
 * Lines that are not plain records (choices between shapes, free keys) stay as cards.
 */

const defaults = getDefaultRegistry().templates
const DefaultFieldTemplate = defaults.FieldTemplate
const DefaultObjectFieldTemplate = defaults.ObjectFieldTemplate

export function RowButton({ icon, label, onClick, disabled, danger, text }: {
  icon: string; label: string; onClick?: IconButtonProps['onClick']; disabled?: boolean; danger?: boolean; text?: boolean
}) {
  return (
    <button type="button" className={`btn btn-quiet${text ? ' btn-sm' : ' btn-icon'}${danger ? ' btn-danger-quiet' : ''}`} onClick={onClick}
      disabled={disabled} title={label} aria-label={label}>
      <Icon name={icon} />{text && <span>{label}</span>}
    </button>
  )
}

export const MoveUpButton = (p: IconButtonProps) => <RowButton icon="up" label="Move up" onClick={p.onClick} disabled={p.disabled} />
export const MoveDownButton = (p: IconButtonProps) => <RowButton icon="down" label="Move down" onClick={p.onClick} disabled={p.disabled} />
export const RemoveButton = (p: IconButtonProps) => <RowButton icon="trash" label="Remove row" danger onClick={p.onClick} disabled={p.disabled} />
export const CopyButton = (p: IconButtonProps) => <RowButton icon="plus" label="Copy row" onClick={p.onClick} disabled={p.disabled} />

export function AddButton({ className, onClick, disabled, id }: IconButtonProps) {
  return (
    <div className={`array-add ${className ?? ''}`}>
      <button type="button" id={id} className="btn btn-sm" onClick={onClick} disabled={disabled} title="Add">
        <Icon name="plus" /> Add row
      </button>
    </div>
  )
}

/* ---------------- grid ---------------- */

interface GridListState {
  path: (string | number)[]
  columns: GridColumn[]
  columnOf: Map<string, number>
  rowErrors: boolean[]
}
const GridListContext = createContext<GridListState | null>(null)

const OPEN_NESTED_UP_TO = 10

const relPath = (path: (string | number)[], from: number) => path.slice(from).join('.')

/** A field of a grid line: a cell in its column (objects add no cell, their fields do). */
export function FieldTemplate(props: FieldTemplateProps) {
  const row = useContext(GridRowContext)
  if (!row) return <DefaultFieldTemplate {...props} />
  const { children, hidden, schema, fieldPathId, rawErrors, label, required, id } = props
  if (hidden) return <div className="hidden">{children}</div>
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type
  if (type === 'object' || (schema.properties && !schema.type)) return <>{children}</>
  const key = relPath(fieldPathId.path, row.path.length)
  const col = row.columnOf.get(key)
  if (col === undefined) return <div className="hidden">{children}</div>
  const errs = rawErrors?.filter(Boolean) ?? []
  const column = row.columns[col]
  return (
    <div role="gridcell" className={`g-cell g-${column.kind}${errs.length ? ' has-error' : ''}`} style={{ gridColumn: col + 2 }}
      title={errs.length ? errs.join('. ') : undefined}>
      {column.kind !== 'list' && (
        <label className="sr-only" htmlFor={id}>{column.group ? `${column.group} › ` : ''}{label || column.title}{required ? ' (required)' : ''}</label>
      )}
      {children}
      {errs.length > 0 && <div className="g-cell-err">{errs[0]}</div>}
    </div>
  )
}

/** An object inside a grid line: no frame and no title, its fields are cells of the line. */
export function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const row = useContext(GridRowContext)
  if (!row) return <DefaultObjectFieldTemplate {...props} />
  return <>{props.properties.map((p) => p.content)}</>
}

function ListGrid(props: ArrayFieldTemplateProps & { columns: GridColumn[] }) {
  const { canAdd, disabled, readonly, fieldPathId, items, onAddClick, formData, registry, schema, columns } = props
  const rows = useMemo(() => (Array.isArray(formData) ? formData : []), [formData])
  const columnOf = useMemo(() => new Map(columns.map((c, i) => [c.key, i])), [columns])
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // RJSF gives list templates no errors: after a submit attempt each line is checked against its schema
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const form = rootRef.current?.closest('form')
    if (!form) return
    const onSubmit = () => setAttempt((n) => n + 1)
    form.addEventListener('submit', onSubmit, true)
    return () => form.removeEventListener('submit', onSubmit, true)
  }, [])
  const rowErrors = useMemo(() => {
    if (!attempt) return rows.map(() => false)
    return rows.map((row) => {
      const itemSchema = registry.schemaUtils.retrieveSchema(schema.items as never, row as never)
      return registry.schemaUtils.getValidator().validateFormData(row as never, itemSchema).errors.length > 0
    })
  }, [attempt, rows, registry, schema.items])

  // lists inside a line open under it, as wide as the visible part of the grid
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const set = () => el.style.setProperty('--vw', `${el.clientWidth}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const count = items.length
  const errorCount = rowErrors.filter(Boolean).length
  const state = useMemo(() => ({ path: fieldPathId.path, columns, columnOf, rowErrors }), [fieldPathId.path, columns, columnOf, rowErrors])
  const addLine = () => {
    onAddClick()
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      el.querySelectorAll<HTMLElement>(':scope > .g > .g-row:last-of-type input, :scope > .g > .g-row:last-of-type select')[0]?.focus()
    })
  }

  return (
    <GridListContext.Provider value={state}>
      <GridRowContext.Provider value={null}>
        <div className="lines" ref={rootRef}>
          <div className="lines-bar">
            {canAdd && (
              <button type="button" id={buttonId(fieldPathId, 'add')} className="btn btn-sm" onClick={addLine} disabled={disabled || readonly}>
                <Icon name="plus" /> Add line
              </button>
            )}
            <span className="lines-count">
              {count === 1 ? '1 line' : `${count} lines`}
              {errorCount > 0 && <b className="lines-count-err"> · {errorCount === 1 ? '1 line needs attention' : `${errorCount} lines need attention`}</b>}
            </span>
            {columns.length > 6 && <span className="lines-hint">{columns.length} columns · scroll sideways for more</span>}
          </div>
          <div className="g-scroll" ref={scrollRef}>
            <div className="g" role="grid" aria-rowcount={count + 1} aria-colcount={columns.length + 2}
              style={{ gridTemplateColumns: gridTemplate(columns) } as CSSProperties}>
              <div className="g-row g-head" role="row">
                <div className="g-hcell g-no" role="columnheader">#</div>
                {columns.map((c, i) => (
                  <div key={c.key || 'value'} className={`g-hcell g-${c.kind}`} role="columnheader" style={{ gridColumn: i + 2 }}
                    title={c.group ? `${c.group} › ${c.title}` : c.title}>
                    {c.group && <span className="g-hgroup">{c.group}</span>}
                    <span className="g-htitle">{c.title}{c.required && <span className="req" aria-hidden="true"> *</span>}</span>
                  </div>
                ))}
                <div className="g-hcell g-tools" role="columnheader" style={{ gridColumn: columns.length + 2 }}><span className="sr-only">Actions</span></div>
              </div>
              {items}
            </div>
            {count === 0 && (
              <div className="lines-empty">
                No lines yet.
                {canAdd && <button type="button" className="btn btn-sm" onClick={addLine} disabled={disabled || readonly}><Icon name="plus" /> Add line</button>}
              </div>
            )}
          </div>
        </div>
      </GridRowContext.Provider>
    </GridListContext.Provider>
  )
}

/** One line of a grid: number, a cell per field, copy / remove, and the lists inside the line under it. */
function GridRow(props: ArrayFieldItemTemplateProps) {
  const list = useContext(GridListContext)
  const { children, buttonsProps: b, hasToolbar, index, totalItems } = props
  const [subEl, setSubEl] = useState<HTMLDivElement | null>(null)
  // lists inside a line start open, unless there are many lines (then the count opens them, so long forms stay quick)
  const [open, setOpen] = useState<Set<string>>(() =>
    totalItems <= OPEN_NESTED_UP_TO ? new Set(list?.columns.filter((c) => c.kind === 'list').map((c) => c.key)) : new Set())
  const toggle = useCallback((key: string) => setOpen((cur) => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }), [])
  const value = useMemo(
    () => (list ? { path: [...list.path, index], columnOf: list.columnOf, columns: list.columns, subEl, open, toggle } : null),
    [list, index, subEl, open, toggle],
  )
  if (!list || !value) return null
  const bad = list.rowErrors[index]
  const off = b.disabled || b.readonly
  const last = list.columns.length + 2
  return (
    <GridRowContext.Provider value={value}>
      <div className={`g-row${bad ? ' has-error' : ''}`} role="row" aria-rowindex={index + 2}>
        <div className="g-cell g-no" role="rowheader" style={{ gridColumn: 1 }}>
          {bad ? <span className="lines-err" title="This line has an error"><Icon name="alert" /></span> : index + 1}
        </div>
        {children}
        <div className="g-cell g-tools" style={{ gridColumn: last }}>
          {hasToolbar && b.hasCopy && <RowButton icon="plus" label={`Copy line ${index + 1}`} disabled={off} onClick={b.onCopyItem} />}
          {hasToolbar && b.hasRemove && <RowButton icon="trash" label={`Remove line ${index + 1}`} danger disabled={off} onClick={b.onRemoveItem} />}
        </div>
        <div className="g-sub" ref={setSubEl} style={{ gridColumn: '1 / -1' }} />
      </div>
    </GridRowContext.Provider>
  )
}

/** A list inside a grid line: its count in the cell, its own grid under the line. */
function NestedList(props: ArrayFieldTemplateProps & { columns: GridColumn[] | null; heading: string }) {
  const row = useContext(GridRowContext)
  const { fieldPathId, items, columns, heading, canAdd, onAddClick, disabled, readonly, registry, uiSchema } = props
  if (!row) return null
  const key = relPath(fieldPathId.path, row.path.length)
  const isOpen = row.open.has(key)
  const n = items.length
  const lineNo = Number(row.path[row.path.length - 1]) + 1
  const { ButtonTemplates: { AddButton: Add } } = registry.templates
  return (
    <>
      <button type="button" className={`g-list-btn${isOpen ? ' is-open' : ''}`} onClick={() => row.toggle(key)} aria-expanded={isOpen}
        title={isOpen ? 'Hide these lines' : 'Show these lines under the line'}>
        <Icon name={isOpen ? 'up' : 'down'} size={14} /> {n === 1 ? '1 line' : `${n} lines`}
      </button>
      {isOpen && row.subEl && createPortal(
        <GridRowContext.Provider value={null}>
          <div className="g-sub-inner">
            <div className="g-sub-head">
              <strong>{heading}</strong>
              <span>of line {lineNo}</span>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => row.toggle(key)}>Hide</button>
            </div>
            {columns ? <ListGrid {...props} columns={columns} /> : (
              <div className="row array-item-list">
                {items}
                {canAdd && <Add id={buttonId(fieldPathId, 'add')} className="rjsf-array-item-add" onClick={onAddClick}
                  disabled={disabled || readonly} uiSchema={uiSchema} registry={registry} />}
              </div>
            )}
          </div>
        </GridRowContext.Provider>,
        row.subEl,
      )}
    </>
  )
}

/** Lists: a grid (cards when lines are not plain records). */
export function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const row = useContext(GridRowContext)
  const { canAdd, className, disabled, fieldPathId, uiSchema, items, optionalDataControl, onAddClick, readonly, registry, required, schema, title } = props
  const uiOptions = getUiOptions(uiSchema)
  const { ArrayFieldTitleTemplate: Title, ArrayFieldDescriptionTemplate: Description, ButtonTemplates: { AddButton: Add } } = registry.templates
  const layout = listLayout(schema.items, (uiSchema as Record<string, never> | undefined)?.items, uiSchema)
  const heading = uiOptions.title || title || (schema as RJSFSchema).title || 'Lines'
  if (row) return <NestedList {...props} columns={layout.mode === 'grid' ? layout.columns : null} heading={String(heading)} />
  const inTitle = !readonly && !disabled
  return (
    <fieldset className={`${className ?? ''}${layout.mode === 'grid' ? ' array-lines' : ''}`} id={fieldPathId.$id}>
      <Title fieldPathId={fieldPathId} title={heading} required={required} schema={schema} uiSchema={uiSchema}
        registry={registry} optionalDataControl={inTitle ? optionalDataControl : undefined} />
      <Description fieldPathId={fieldPathId} description={uiOptions.description || schema.description} schema={schema}
        uiSchema={uiSchema} registry={registry} />
      {!inTitle ? optionalDataControl : undefined}
      {layout.mode === 'grid' ? <ListGrid {...props} columns={layout.columns} /> : (
        <GridRowContext.Provider value={null}>
          <div className="row array-item-list">{items}</div>
          {canAdd && <Add id={buttonId(fieldPathId, 'add')} className="rjsf-array-item-add" onClick={onAddClick}
            disabled={disabled || readonly} uiSchema={uiSchema} registry={registry} />}
        </GridRowContext.Provider>
      )}
    </fieldset>
  )
}

export function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const list = useContext(GridListContext)
  const { children, buttonsProps: b, hasToolbar, index, totalItems } = props
  const off = b.disabled || b.readonly
  const layout = listLayout(props.schema, props.parentUiSchema?.items as never, props.parentUiSchema)
  if (list && layout.mode === 'grid') return <GridRow {...props} />
  return (
    <div className="array-row">
      <div className="array-row-head">
        <span className="array-row-title">Row {index + 1} of {totalItems}</span>
        {hasToolbar && (
          <div className="array-row-tools">
            {(b.hasMoveUp || b.hasMoveDown) && <RowButton icon="up" label="Move up" onClick={b.onMoveUpItem} disabled={off || !b.hasMoveUp} />}
            {(b.hasMoveUp || b.hasMoveDown) && <RowButton icon="down" label="Move down" onClick={b.onMoveDownItem} disabled={off || !b.hasMoveDown} />}
            {b.hasCopy && <RowButton icon="plus" label="Copy row" onClick={b.onCopyItem} disabled={off} />}
            {b.hasRemove && <RowButton icon="trash" label="Remove row" danger onClick={b.onRemoveItem} disabled={off} />}
          </div>
        )}
      </div>
      <div className="array-row-body">{children}</div>
    </div>
  )
}
