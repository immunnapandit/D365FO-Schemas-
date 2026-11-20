import { buttonId, getUiOptions } from '@rjsf/utils'
import type { ArrayFieldItemTemplateProps, ArrayFieldTemplateProps, IconButtonProps } from '@rjsf/utils'
import type { CSSProperties } from 'react'
import { gridColumns } from '../lib/array-grid'
import Icon from './Icon'

/**
 * Form parts for lists in a form (e.g. invoices with their line items): each row is a card with a
 * "Row n of m" header and labelled buttons, instead of RJSF's Bootstrap glyph buttons.
 */

function RowButton({ icon, label, onClick, disabled, danger }: {
  icon: string; label: string; onClick?: IconButtonProps['onClick']; disabled?: boolean; danger?: boolean
}) {
  return (
    <button type="button" className={`btn btn-quiet btn-icon${danger ? ' btn-danger-quiet' : ''}`} onClick={onClick}
      disabled={disabled} title={label} aria-label={label}>
      <Icon name={icon} />
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

/** Lists of rows with single-value fields (e.g. invoice lines) are shown as a table; anything else as cards. */
export function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { canAdd, className, disabled, fieldPathId, uiSchema, items, optionalDataControl, onAddClick, readonly, registry, required, schema, title } = props
  const uiOptions = getUiOptions(uiSchema)
  const { ArrayFieldTitleTemplate: Title, ArrayFieldDescriptionTemplate: Description, ButtonTemplates: { AddButton: Add } } = registry.templates
  const cols = gridColumns(schema.items, (uiSchema as Record<string, never> | undefined)?.items)
  const inTitle = !readonly && !disabled
  return (
    <fieldset className={`${className ?? ''}${cols ? ' array-grid' : ''}`} id={fieldPathId.$id}>
      <Title fieldPathId={fieldPathId} title={uiOptions.title || title} required={required} schema={schema} uiSchema={uiSchema}
        registry={registry} optionalDataControl={inTitle ? optionalDataControl : undefined} />
      <Description fieldPathId={fieldPathId} description={uiOptions.description || schema.description} schema={schema}
        uiSchema={uiSchema} registry={registry} />
      {!inTitle ? optionalDataControl : undefined}
      {cols ? (
        <div className="array-grid-scroll">
          <div className="array-grid-inner" style={{ '--cols': cols.length } as CSSProperties}>
            <div className="array-grid-head" aria-hidden="true">
              <span className="array-grid-no">#</span>
              <div className="array-grid-cols">
                {cols.map((c) => <span key={c.key} title={c.title}>{c.title}{c.required && <b className="req"> *</b>}</span>)}
              </div>
              <span className="array-grid-tools" />
            </div>
            {items.length === 0 && <div className="array-grid-empty">No rows yet. Use “Add row” to start.</div>}
            <div className="array-item-list">{items}</div>
          </div>
        </div>
      ) : (
        <div className="row array-item-list">{items}</div>
      )}
      {canAdd && <Add id={buttonId(fieldPathId, 'add')} className="rjsf-array-item-add" onClick={onAddClick}
        disabled={disabled || readonly} uiSchema={uiSchema} registry={registry} />}
    </fieldset>
  )
}

export function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const { children, buttonsProps: b, hasToolbar, index, totalItems } = props
  const off = b.disabled || b.readonly
  if (gridColumns(props.schema, props.parentUiSchema?.items as never)) {
    return (
      <div className="array-row array-row-grid">
        <span className="array-grid-no">{index + 1}</span>
        <div className="array-row-body">{children}</div>
        <div className="array-grid-tools">
          {hasToolbar && (
            <>
              {b.hasCopy && <RowButton icon="plus" label="Copy row" onClick={b.onCopyItem} disabled={off} />}
              {b.hasRemove && <RowButton icon="trash" label="Remove row" danger onClick={b.onRemoveItem} disabled={off} />}
            </>
          )}
        </div>
      </div>
    )
  }
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
