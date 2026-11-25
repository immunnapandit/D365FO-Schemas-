import type { FormDefinition } from './types'

export interface Template {
  key: string
  label: string
  description: string
  def: FormDefinition
}

/** Sign-in is set up once on the module (click the module name in the sidebar). */
const entraAuth = { type: 'module' as const }

/** Starting points for a new form. Every value can be changed in the designer. */
export const templates: Template[] = [
  {
    key: 'fno-odata',
    label: 'F&O data entity',
    description: 'Insert a record through OData with an Entra ID token.',
    def: {
      name: '',
      icon: 'document',
      auth: entraAuth,
      api: { method: 'POST', url: '{{env:FNO_BASE_URL}}/data/' },
      formSchema: {
        type: 'object',
        required: ['dataAreaId'],
        properties: { dataAreaId: { type: 'string', title: 'Company' } },
      },
      uiSchema: {},
    },
  },
  {
    key: 'fno-service',
    label: 'F&O custom service',
    description: 'Call an X++ service operation with an Entra ID token.',
    def: {
      name: '',
      icon: 'service',
      auth: entraAuth,
      api: { method: 'POST', url: '{{env:FNO_BASE_URL}}/api/services/', bodyTemplate: { _request: {} } },
      formSchema: { type: 'object', properties: {} },
      uiSchema: {},
    },
  },
  {
    key: 'login-api',
    label: 'API with a login URL',
    description: 'Sign in with a user name and password, then call the API with the token.',
    def: {
      name: '',
      icon: 'globe',
      auth: { type: 'oauth2_password', tokenUrl: '', username: '', password: '' },
      api: { method: 'POST', url: '' },
      formSchema: { type: 'object', properties: {} },
      uiSchema: {},
    },
  },
  {
    key: 'blank',
    label: 'Blank form',
    description: 'Start with nothing filled in.',
    def: {
      name: '',
      icon: 'document',
      auth: { type: 'module' }, // sign-in is set once on the module; change it on the Sign-in tab if needed
      api: { method: 'POST', url: '' },
      formSchema: { type: 'object', properties: {} },
      uiSchema: {},
    },
  },
]
