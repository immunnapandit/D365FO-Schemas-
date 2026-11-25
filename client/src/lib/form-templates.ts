import type { TemplatesType, UiSchema } from '@rjsf/utils'
import {
  AddButton, ArrayFieldItemTemplate, ArrayFieldTemplate, CopyButton, FieldTemplate, MoveDownButton, MoveUpButton, ObjectFieldTemplate, RemoveButton,
} from '../components/formTemplates'

/** RJSF templates used by every form: lists are grids (a column per field, typed in place). */
export const formTemplates: Partial<TemplatesType> = {
  ArrayFieldTemplate,
  ArrayFieldItemTemplate,
  FieldTemplate,
  ObjectFieldTemplate,
  ButtonTemplates: { AddButton, MoveUpButton, MoveDownButton, RemoveButton, CopyButton } as unknown as TemplatesType['ButtonTemplates'],
}

/** Lists can copy a line ("Copy line") unless the form's uiSchema turns it off. */
export function withListOptions(uiSchema?: UiSchema): UiSchema {
  const global = (uiSchema?.['ui:globalOptions'] ?? {}) as Record<string, unknown>
  return { ...uiSchema, 'ui:globalOptions': { copyable: true, ...global } }
}
