/** Names an admin can pick as a form icon (same list as the server). */
export const FORM_ICONS = [
  'document', 'cart', 'invoice', 'customer', 'vendor', 'product',
  'warehouse', 'truck', 'ledger', 'project', 'service', 'globe',
] as const

export const isFormIcon = (name?: string): boolean => !!name && (FORM_ICONS as readonly string[]).includes(name)
