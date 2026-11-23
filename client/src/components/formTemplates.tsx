import { buttonId, getUiOptions } from '@rjsf/utils'
import type { ArrayFieldItemTemplateProps, ArrayFieldTemplateProps, IconButtonProps } from '@rjsf/utils'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { cellText, listLayout } from '../lib/array-grid'
import type { GridColumn } from '../lib/array-grid'
import { LinesContext } from '../lib/lines-context'
import Icon from './Icon'

/**
 * Form parts for lists in a form (e.g. invoices with their line items). Lists of lines share one design:
 * - few fields per line: the lines grid, typed in place
 * - many fields per line: the lines grid with the key columns and a "Line details" panel for the selected line
 * - anything else: a card per row
 */

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

/** A list of long rows: lines grid with the key columns, and every field of the selected line below it. */
function LinesEditor(props: ArrayFieldTemplateProps & { columns: GridColumn[]; fieldCount: number; heading: string; editable: boolean }) {
  const { canAdd, disabled, readonly, fieldPathId, items, onAddClick, formData, registry, schema, columns, fieldCount, heading, editable } = props
  const rows = useMemo(() => (Array.isArray(formData) ? formData : []), [formData])
  const [selected, setSelected] = useState(0)
  const [detailsEl, setDetailsEl] = useState<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  const added = useRef(false)
  const count = items.length
  const current = Math.min(selected, Math.max(count - 1, 0))

  // RJSF does not hand list templates their errors, so each line is checked against its schema once
  // the user has tried to submit; the first line with an error then opens in the details
  const rootRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (added.current) { added.current = false; setSelected(count - 1) }
  }, [count])
  useEffect(() => {
    if (!attempt) return
    setSelected((cur) => {
      const first = rowErrors.indexOf(true)
      return first >= 0 && !rowErrors[cur] ? first : cur
    })
    // only when the user submits, not on every keystroke
  }, [attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  const select = (i: number, focusRow = false) => {
    const next = Math.max(0, Math.min(i, count - 1))
    setSelected(next)
    if (focusRow) requestAnimationFrame(() => bodyRef.current?.querySelectorAll<HTMLElement>('tr')[next]?.focus())
  }
  const add = () => { added.current = true; onAddClick() }
  const errorCount = rowErrors.filter(Boolean).length

  return (
    <LinesContext.Provider value={{ columns, rows, rowErrors, selected: current, select, detailsEl, title: heading, editable }}>
      <div className={`lines${editable ? ' lines-editable' : ''}`} ref={rootRef}>
        <div className="lines-bar">
          {canAdd && (
            <button type="button" id={buttonId(fieldPathId, 'add')} className="btn btn-sm" onClick={add} disabled={disabled || readonly}>
              <Icon name="plus" /> Add line
            </button>
          )}
          <span className="lines-count">
            {count === 1 ? '1 line' : `${count} lines`}
            {errorCount > 0 && <b className="lines-count-err"> · {errorCount === 1 ? '1 line needs attention' : `${errorCount} lines need attention`}</b>}
          </span>
          {!editable && <span className="lines-hint">{fieldCount} fields per line · select a line to edit all of them</span>}
        </div>
        <div className="lines-scroll">
          <table className="lines-grid" style={{ '--cols': columns.length } as CSSProperties}>
            <thead>
              <tr>
                <th className="lines-no" scope="col">#</th>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined} title={c.title}>
                    {c.title}{c.required && <span className="req" aria-hidden="true"> *</span>}
                  </th>
                ))}
                <th className="lines-tools" scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody ref={bodyRef}>{items}</tbody>
          </table>
          {count === 0 && (
            <div className="lines-empty">
              No lines yet.
              {canAdd && <button type="button" className="btn btn-sm" onClick={add} disabled={disabled || readonly}><Icon name="plus" /> Add line</button>}
            </div>
          )}
        </div>
        {!editable && <section className="line-details" ref={setDetailsEl} aria-label="Line details" hidden={count === 0} />}
      </div>
    </LinesContext.Provider>
  )
}

/** Lists of rows: a table, a lines grid with details, or cards (see LinesEditor and listLayout). */
export function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { canAdd, className, disabled, fieldPathId, uiSchema, items, optionalDataControl, onAddClick, readonly, registry, required, schema, title } = props
  const uiOptions = getUiOptions(uiSchema)
  const { ArrayFieldTitleTemplate: Title, ArrayFieldDescriptionTemplate: Description, ButtonTemplates: { AddButton: Add } } = registry.templates
  const layout = listLayout(schema.items, (uiSchema as Record<string, never> | undefined)?.items, uiSchema)
  const inTitle = !readonly && !disabled
  const heading = uiOptions.title || title || 'Line'
  return (
    <fieldset className={`${className ?? ''}${layout.mode !== 'cards' ? ' array-lines' : ''}`} id={fieldPathId.$id}>
      <Title fieldPathId={fieldPathId} title={heading} required={required} schema={schema} uiSchema={uiSchema}
        registry={registry} optionalDataControl={inTitle ? optionalDataControl : undefined} />
      <Description fieldPathId={fieldPathId} description={uiOptions.description || schema.description} schema={schema}
        uiSchema={uiSchema} registry={registry} />
      {!inTitle ? optionalDataControl : undefined}
      {layout.mode !== 'cards' ? (
        <LinesEditor {...props} columns={layout.columns} fieldCount={layout.mode === 'lines' ? layout.fieldCount : layout.columns.length}
          heading={heading} editable={layout.mode === 'inline'} />
      ) : (
        <div className="row array-item-list">{items}</div>
      )}
      {canAdd && layout.mode === 'cards' && <Add id={buttonId(fieldPathId, 'add')} className="rjsf-array-item-add" onClick={onAddClick}
        disabled={disabled || readonly} uiSchema={uiSchema} registry={registry} />}
    </fieldset>
  )
}

/** One line of a lines grid: its key values in the grid, and all its fields in "Line details" when selected. */
function LineRow(props: ArrayFieldItemTemplateProps) {
  const lines = useContext(LinesContext)
  const { children, buttonsProps: b, hasToolbar, index, totalItems } = props
  if (!lines) return null
  const { columns, rows, rowErrors, selected, select, detailsEl, title, editable } = lines
  const row = (rows[index] ?? {}) as Record<string, unknown>
  const isSelected = selected === index
  const bad = rowErrors[index]
  const off = b.disabled || b.readonly

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'ArrowDown') { e.preventDefault(); select(index + 1, true) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(index - 1, true) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      detailsEl?.querySelector<HTMLElement>('input, select, textarea')?.focus()
    }
  }

  return (
    <tr className={`${isSelected ? 'is-selected' : ''}${bad ? ' has-error' : ''}`} tabIndex={0} aria-selected={isSelected}
      onClick={() => select(index)} onKeyDown={onKey}>
      <td className="lines-no">{bad ? <span className="lines-err" title="This line has an error"><Icon name="alert" /></span> : index + 1}</td>
      {editable ? (
        <td className="lines-edit" colSpan={columns.length} onFocus={() => select(index)}>{children}</td>
      ) : columns.map((c) => {
        const text = cellText(row[c.key], c)
        return <td key={c.key} className={c.numeric ? 'num' : undefined} title={text || undefined}>{text || <span className="lines-blank" />}</td>
      })}
      <td className="lines-tools" onClick={(e) => e.stopPropagation()}>
        {hasToolbar && b.hasRemove && (
          <RowButton icon="trash" label={`Remove line ${index + 1}`} danger disabled={off}
            onClick={(e) => { b.onRemoveItem(e); select(Math.min(index, totalItems - 2)) }} />
        )}
        {!editable && isSelected && detailsEl && createPortal(
          <>
            <header className="line-details-head">
              <div className="line-details-title">
                <h3>Line details</h3>
                <span>{title} · line {index + 1} of {totalItems}</span>
              </div>
              <div className="line-details-nav">
                <RowButton icon="up" label="Previous line" onClick={() => select(index - 1)} disabled={index === 0} />
                <RowButton icon="down" label="Next line" onClick={() => select(index + 1)} disabled={index >= totalItems - 1} />
              </div>
              {hasToolbar && (
                <div className="line-details-actions">
                  {(b.hasMoveUp || b.hasMoveDown) && (
                    <RowButton icon="up" label="Move up" text disabled={off || !b.hasMoveUp}
                      onClick={(e) => { b.onMoveUpItem(e); select(index - 1) }} />
                  )}
                  {(b.hasMoveUp || b.hasMoveDown) && (
                    <RowButton icon="down" label="Move down" text disabled={off || !b.hasMoveDown}
                      onClick={(e) => { b.onMoveDownItem(e); select(index + 1) }} />
                  )}
                  {b.hasCopy && (
                    <RowButton icon="plus" label="Copy line" text disabled={off}
                      onClick={(e) => { b.onCopyItem(e); select(index + 1) }} />
                  )}
                  {b.hasRemove && (
                    <RowButton icon="trash" label="Remove line" text danger disabled={off}
                      onClick={(e) => { b.onRemoveItem(e); select(Math.min(index, totalItems - 2)) }} />
                  )}
                </div>
              )}
            </header>
            <div className="line-details-body">{children}</div>
          </>,
          detailsEl,
        )}
      </td>
    </tr>
  )
}

export function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const { children, buttonsProps: b, hasToolbar, index, totalItems } = props
  const off = b.disabled || b.readonly
  const layout = listLayout(props.schema, props.parentUiSchema?.items as never, props.parentUiSchema)
  if (layout.mode !== 'cards') return <LineRow {...props} />
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
