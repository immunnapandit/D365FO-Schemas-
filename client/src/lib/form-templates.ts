import type { TemplatesType } from '@rjsf/utils'
import { AddButton, ArrayFieldItemTemplate, CopyButton, MoveDownButton, MoveUpButton, RemoveButton } from '../components/formTemplates'

/** RJSF templates used by every form: lists show each row as a card with labelled buttons. */
export const formTemplates: Partial<TemplatesType> = {
  ArrayFieldItemTemplate,
  ButtonTemplates: { AddButton, MoveUpButton, MoveDownButton, RemoveButton, CopyButton } as unknown as TemplatesType['ButtonTemplates'],
}
