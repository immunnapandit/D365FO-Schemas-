import type { ArrayFieldItemTemplateProps, IconButtonProps } from '@rjsf/utils'
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

export function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const { children, buttonsProps: b, hasToolbar, index, totalItems } = props
  const off = b.disabled || b.readonly
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
