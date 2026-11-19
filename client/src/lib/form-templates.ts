import type { TemplatesType } from '@rjsf/utils'
import { AddButton, ArrayFieldItemTemplate, ArrayFieldTemplate, CopyButton, MoveDownButton, MoveUpButton, RemoveButton } from '../components/formTemplates'

/** RJSF templates used by every form: flat lists show as a table with Add row, nested lists as cards. */
export const formTemplates: Partial<TemplatesType> = {
  ArrayFieldTemplate,
  ArrayFieldItemTemplate,
  ButtonTemplates: { AddButton, MoveUpButton, MoveDownButton, RemoveButton, CopyButton } as unknown as TemplatesType['ButtonTemplates'],
}
