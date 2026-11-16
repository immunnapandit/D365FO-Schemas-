import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * JSON Schema of a *schema definition*. Single source of truth:
 *  - the server validates every save against it
 *  - the browser downloads it (/api/meta/definition-schema) for editor autocomplete
 */
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const strMap = (description) => ({ type: 'object', description, additionalProperties: { type: 'string' } });

export const AUTH_TYPES = ['none', 'basic', 'bearer_static', 'api_key', 'oauth2_client_credentials', 'oauth2_password', 'token_endpoint'];
export const ICONS = ['document', 'cart', 'invoice', 'customer', 'vendor', 'product', 'warehouse', 'truck', 'ledger', 'project', 'service', 'globe'];
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export const definitionSchema = {
  $id: 'https://schema-forms/definition.json',
  type: 'object',
  required: ['name', 'auth', 'api', 'formSchema'],
  additionalProperties: false,
  properties: {
    id: str('Set by the server. Do not change.'),
    version: { type: 'integer', description: 'Set by the server. Used to detect concurrent edits.' },
    name: str('Name shown in the sidebar.', { minLength: 1, maxLength: 200 }),
    description: str('Short description shown above the form.', { maxLength: 2000 }),
    icon: {
      enum: ICONS,
      description: 'Icon shown next to the form name.',
    },
    category: str('Module the form is listed under in the navigation, e.g. Sales, Procurement.', { maxLength: 60 }),
    allowedRoles: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Optional. Only users with one of these Entra ID app roles can see and submit this form. Admins always can.',
    },
    createdAt: { type: 'string' },
    createdBy: { type: ['string', 'null'] },
    updatedAt: { type: 'string' },
    updatedBy: { type: ['string', 'null'] },
    auth: {
      type: 'object',
      required: ['type'],
      description:
        'How to authenticate. Use {{env:NAME}} (server setting) or {{kv:secret-name}} (Azure Key Vault) for secrets.',
      properties: {
        type: {
          enum: AUTH_TYPES,
          enumDescriptions: [
            'No authentication',
            'Basic auth: username + password',
            'A fixed bearer token: token',
            'A fixed header: headerName + value',
            'Entra ID / D365 F&O: tokenUrl, clientId, clientSecret, scope',
            'OAuth 2.0 with a service account: tokenUrl, username, password (clientId, clientSecret, scope optional)',
            'Call a login URL and read the token from the response: url, body, tokenPath',
          ],
        },
        tokenUrl: str('oauth2: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token'),
        clientId: str('oauth2: Application (client) ID'),
        clientSecret: str('oauth2: client secret. Prefer {{kv:secret-name}}'),
        scope: str('oauth2: for F&O use https://<env>.operations.dynamics.com/.default'),
        resource: str('oauth2 (old v1 endpoint only)'),
        extraParams: strMap('oauth2: extra form fields for the token request'),
        username: str('basic: username'),
        password: str('basic: password'),
        token: str('bearer_static: the token'),
        headerName: str('api_key / token_endpoint: header name, default Authorization'),
        value: str('api_key: header value'),
        url: str('token_endpoint: login URL'),
        method: { enum: HTTP_METHODS, description: 'token_endpoint: HTTP method, default POST' },
        bodyType: { enum: ['json', 'form'], description: 'token_endpoint: how to send the body' },
        body: { type: 'object', description: 'token_endpoint: request body, e.g. { "username": "...", "password": "..." }' },
        headers: strMap('token_endpoint: extra headers'),
        tokenPath: str('token_endpoint: where the token is in the response, e.g. access_token or data.token'),
        expiresInPath: str('token_endpoint: where expiry seconds are, default expires_in'),
        prefix: str('token_endpoint: text before the token in the header, default "Bearer "'),
      },
      allOf: [
        { if: { properties: { type: { const: 'basic' } } }, then: { required: ['username', 'password'] } },
        { if: { properties: { type: { const: 'bearer_static' } } }, then: { required: ['token'] } },
        { if: { properties: { type: { const: 'api_key' } } }, then: { required: ['headerName', 'value'] } },
        {
          if: { properties: { type: { const: 'oauth2_client_credentials' } } },
          then: { required: ['tokenUrl', 'clientId', 'clientSecret'] },
        },
        {
          if: { properties: { type: { const: 'oauth2_password' } } },
          then: { required: ['tokenUrl', 'username', 'password'] },
        },
        { if: { properties: { type: { const: 'token_endpoint' } } }, then: { required: ['url'] } },
      ],
    },
    api: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      description: 'The API called on Submit.',
      properties: {
        method: { enum: HTTP_METHODS },
        url: str('Full URL. Can use {{env:NAME}} and {{form.field}}.', { minLength: 1 }),
        headers: strMap('Extra request headers'),
        query: strMap('Query string parameters, e.g. { "cross-company": "true" }'),
        bodyType: { enum: ['json', 'form'] },
        bodyTemplate: {
          description:
            'Optional shape of the request body. Use "{{form.field}}" and filters: | datetime, | number, | lower, | upper. If missing, the form data is sent as-is.',
        },
        successMessage: str('Message shown on success. Can use {{response.Field}} and {{form.field}}.'),
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: 'Request timeout for this API' },
      },
    },
    formSchema: {
      type: 'object',
      description: 'Standard JSON Schema for the form fields (type, title, required, enum, default, format…).',
    },
    uiSchema: {
      type: 'object',
      description: 'Optional RJSF uiSchema: ui:placeholder, ui:help, ui:widget, ui:order…',
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateDefinitionShape = ajv.compile(definitionSchema);

/** Returns a list of readable problems (empty = valid). */
export function validateDefinition(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return ['The schema definition must be a JSON object.'];
  const errors = [];
  if (!validateDefinitionShape(def)) {
    for (const e of validateDefinitionShape.errors) {
      if (e.keyword === 'if') continue;
      const where = e.instancePath ? e.instancePath.slice(1).replace(/\//g, '.') : 'definition';
      if (e.keyword === 'required') errors.push(`${where}: "${e.params.missingProperty}" is required`);
      else if (e.keyword === 'additionalProperties') errors.push(`${where}: unknown property "${e.params.additionalProperty}"`);
      else if (e.keyword === 'enum') errors.push(`${where}: must be one of ${e.params.allowedValues.join(', ')}`);
      else errors.push(`${where}: ${e.message}`);
    }
  }
  if (def.formSchema && typeof def.formSchema === 'object') {
    try {
      const check = new Ajv({ strict: false });
      addFormats(check);
      check.compile(def.formSchema);
    } catch (e) {
      errors.push(`formSchema is not a valid JSON Schema: ${e.message}`);
    }
    if (def.formSchema.type && def.formSchema.type !== 'object') errors.push('formSchema.type must be "object".');
  }
  return [...new Set(errors)];
}
