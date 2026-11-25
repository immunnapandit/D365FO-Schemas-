import { swagger2ToOpenApi3 } from './swagger2.js';
import YAML from 'yaml';

/**
 * Turns an OpenAPI 3 file (YAML or JSON, e.g. a Postman collection exported as OpenAPI) into
 * one module (sign-in + variables) and one form per request.
 *
 * - The token request of the collection (…/oauth2/v2.0/token, or a body with grant_type) is not a form:
 *   it becomes the module's OAuth 2.0 sign-in, so the backend gets the token itself.
 * - Path and query parameters become form fields; the JSON request body schema becomes the form.
 *   Postman bodies often only have an example and no schema, so the schema is built from the example.
 * - {{tenantId}}-style placeholders (Postman variables) are kept and listed as module variables.
 */

export class ImportError extends Error {}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const KNOWN_FORMATS = new Set(['date', 'date-time', 'time', 'email', 'uri', 'uuid']);
import { applySampleDefaults, emptySkeleton } from './postman.js';

const DROP_KEYS = new Set(['example', 'examples', 'xml', 'externalDocs', 'discriminator', 'deprecated', 'nullable', 'readOnly', 'writeOnly']);

/* ---------------- parsing ---------------- */

/** YAML or JSON text -> object. */
export function parseText(content) {
  if (typeof content !== 'string' || !content.trim()) throw new ImportError('The file is empty.');
  let doc;
  try {
    doc = content.trim().startsWith('{') ? JSON.parse(content) : YAML.parse(content, { maxAliasCount: 100 });
  } catch (e) {
    throw new ImportError(`The file is not valid YAML or JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object') throw new ImportError('The file is not an OpenAPI document or a Postman collection.');
  return doc;
}

export function parseSpec(content) {
  const doc = typeof content === 'string' ? parseText(content) : content;
  if (doc.info?._postman_id || String(doc.info?.schema ?? '').includes('getpostman')) {
    throw new ImportError('This is a Postman collection file. In Postman, export the collection as "OpenAPI" (YAML or JSON) and import that file.');
  }
  if (String(doc.swagger ?? '').startsWith('2')) return parseSpec(swagger2ToOpenApi3(doc));
  if (!String(doc.openapi ?? '').startsWith('3')) {
    throw new ImportError('This file is not a Postman collection (v2.0 / v2.1) or an OpenAPI file (Swagger 2.0 or OpenAPI 3). Export the API from Postman or Swagger and import that file.');
  }
  if (!doc.paths || typeof doc.paths !== 'object' || !Object.keys(doc.paths).length) throw new ImportError('The file has no requests (paths).');
  return doc;
}

/* ---------------- $ref ---------------- */

function makeResolver(doc, missing = new Set()) {
  const lookup = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) {
      missing.add(ref); // external refs (other files, URLs) are not supported
      return undefined;
    }
    return ref
      .slice(2)
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((acc, k) => (acc == null ? undefined : acc[k]), doc);
  };
  const deref = (value, seen = new Set(), depth = 0) => {
    if (depth > 30) return {};
    if (Array.isArray(value)) return value.map((v) => deref(v, seen, depth + 1));
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) {
      if (seen.has(value.$ref)) return {}; // recursive schema -> stop
      const target = lookup(value.$ref);
      if (target === undefined) missing.add(value.$ref);
      return target === undefined ? {} : deref(target, new Set([...seen, value.$ref]), depth + 1);
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deref(v, seen, depth + 1)]));
  };
  return deref;
}

/* ---------------- schemas ---------------- */

/** OpenAPI schema -> JSON Schema the form renderer and validators understand. */
export function toFormSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'string' };
  if (Array.isArray(schema.allOf) && !schema.properties && !schema.type) {
    return toFormSchema(
      schema.allOf.reduce(
        (acc, s) => ({
          ...acc,
          ...s,
          properties: { ...acc.properties, ...s?.properties },
          required: [...(acc.required ?? []), ...(s?.required ?? [])],
        }),
        { properties: {}, required: [] },
      ),
    );
  }
  const hasExampleOnly = schema.example !== undefined && !schema.properties && (!schema.type || schema.type === 'object');
  if (hasExampleOnly && schema.example && typeof schema.example === 'object') return inferSchema(schema.example);

  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROP_KEYS.has(k) || k.startsWith('x-')) continue;
    if (k === 'format' && !KNOWN_FORMATS.has(v)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [name, prop] of Object.entries(v)) {
        if (name.startsWith('@') || prop?.readOnly) continue; // @odata.etag and read-only fields are not sent
        out.properties[name] = toFormSchema(prop);
      }
    } else if (k === 'items') {
      out.items = toFormSchema(v);
    } else if (k === 'required' && Array.isArray(v)) {
      out.required = v.filter((n) => !String(n).startsWith('@') && !schema.properties?.[n]?.readOnly);
    } else {
      out[k] = v;
    }
  }
  if (out.properties && !out.type) out.type = 'object';
  if (out.required && !out.required.length) delete out.required;
  return out;
}

/** Builds a schema from a sample value, e.g. a record copied from an OData response. */
export function inferSchema(value) {
  if (Array.isArray(value)) return { type: 'array', items: value.length ? inferSchema(value[0]) : { type: 'string' } };
  if (value && typeof value === 'object') {
    const properties = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('@')) continue;
      properties[k] = inferSchema(v);
    }
    return { type: 'object', properties };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

/* ---------------- helpers ---------------- */

function decodePath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** First server, with its variables filled in. No server, or a relative one: {{baseUrl}} (a module variable). */
function serverUrl(servers) {
  const s = servers?.[0];
  const url = String(s?.url ?? '')
    .replace(/\{(\w+)\}/g, (m, name) => s.variables?.[name]?.default ?? m)
    .replace(/\/+$/, '');
  return /^(https?:)?\/\/|^\{\{/i.test(url) ? url : `{{baseUrl}}${url && !url.startsWith('/') ? '/' : ''}${url}`;
}

const VARIABLE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
function collectVariables(text, into) {
  for (const m of String(text ?? '').matchAll(VARIABLE)) into.add(m[1]);
}

/** {customerId} (OpenAPI path parameter) -> {{form.customerId}}; {{tenantId}} (Postman variable) is kept. */
/** server + path; a path that already has its own address ({{base_url}}/…, https://…) is kept as it is */
function joinUrl(base, path) {
  if (/^(\{\{|https?:\/\/)/i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function pathParamsToForm(url) {
  return url.replace(/(?<!\{)\{([A-Za-z_][\w.-]*)\}(?!\})/g, '{{form.$1}}');
}

function pickContent(content) {
  if (!content || typeof content !== 'object') return null;
  const types = Object.keys(content);
  const json = types.find((t) => t === 'application/json' || /\+json$|\/json/.test(t));
  const form = types.find((t) => t === 'application/x-www-form-urlencoded');
  const type = json || form || types[0];
  if (!type) return null;
  const media = content[type] ?? {};
  let schema = media.schema;
  const example = media.example ?? Object.values(media.examples ?? {})[0]?.value;
  if ((!schema || (!schema.properties && !schema.items && !schema.allOf)) && example && typeof example === 'object') {
    schema = inferSchema(example);
  }
  // the example that fills the form: on the media type, or on the schema itself (Bruno/Postman exports)
  const sample = example ?? media.schema?.example ?? Object.values(media.schema?.examples ?? {})[0];
  return { type, bodyType: type === 'application/x-www-form-urlencoded' ? 'form' : 'json', schema: schema ?? null, example: sample };
}

const isTokenRequest = (path, method, body) =>
  method === 'post' &&
  (/\/oauth2(\/v2\.0)?\/token\/?$/i.test(path) || Boolean(body?.schema?.properties?.grant_type));

/** The module's sign-in: the scheme the file asks for first (top-level security), else the first one it defines. */
function authFromSecuritySchemes(schemes, security) {
  const preferred = (security ?? []).flatMap((req) => Object.keys(req ?? {}));
  const ordered = [...preferred.filter((n) => schemes?.[n]), ...Object.keys(schemes ?? {}).filter((n) => !preferred.includes(n))];
  for (const s of ordered.map((n) => schemes[n])) {
    if (s?.type === 'oauth2' && s.flows?.clientCredentials?.tokenUrl) {
      const f = s.flows.clientCredentials;
      return { type: 'oauth2_client_credentials', tokenUrl: f.tokenUrl, clientId: '', clientSecret: '', scope: Object.keys(f.scopes ?? {})[0] ?? '' };
    }
    if (s?.type === 'http' && String(s.scheme).toLowerCase() === 'basic') return { type: 'basic', username: '', password: '' };
    if (s?.type === 'apiKey' && s.in === 'header') return { type: 'api_key', headerName: s.name, value: '' };
    if (s?.type === 'http' && String(s.scheme).toLowerCase() === 'bearer') return { type: 'bearer_static', token: '' };
  }
  return null;
}

/**
 * API gateway keys (Azure APIM) belong to the module, not to the form: the request gets a {{var:…}}
 * placeholder and the value from the file is kept as an encrypted module variable.
 */
const GATEWAY_KEY = /^(subscription-key|ocp-apim-subscription-key)$/i;

const ICON_BY_METHOD = { GET: 'globe', POST: 'document', PUT: 'document', PATCH: 'document', DELETE: 'document' };

/* ---------------- plan ---------------- */

/**
 * @returns {{ moduleName, auth, authSource, variables: string[], variableValues, requests: Array<{ key, name, method, url, definition }> }}
 */
export function buildImportPlan(doc, { moduleName } = {}) {
  const missingRefs = new Set();
  const deref = makeResolver(doc, missingRefs);
  const warnings = [];
  const schemes = deref(doc.components?.securitySchemes) ?? {};
  const moduleScheme = (() => {
    const preferred = (doc.security ?? []).flatMap((r) => Object.keys(r ?? {})).find((n) => schemes[n]);
    if (preferred) return preferred;
    return Object.keys(schemes).find((n) => authFromSecuritySchemes({ [n]: schemes[n] }));
  })();
  /** a key from an apiKey scheme, as a module variable */
  const schemeKeyVar = (name) => {
    const v = `${name.replace(/[^A-Za-z0-9]/g, '') || 'api'}Key`;
    variables.add(v);
    if (!(v in variableValues)) variableValues[v] = '';
    return v;
  };
  const variables = new Set();
  const variableValues = {};
  const keyVarByValue = new Map();
  /** one module variable per distinct key value: subscriptionKey, subscriptionKey2, … */
  const gatewayKeyVar = (value) => {
    const v = value === undefined || value === null ? '' : String(value);
    if (keyVarByValue.has(v)) return keyVarByValue.get(v);
    const name = keyVarByValue.size === 0 ? 'subscriptionKey' : `subscriptionKey${keyVarByValue.size + 1}`;
    keyVarByValue.set(v, name);
    variables.add(name);
    variableValues[name] = v;
    return name;
  };
  const requests = [];
  let auth = null;
  let authSource = null;

  for (const [rawPath, rawItem] of Object.entries(doc.paths)) {
    const item = deref(rawItem) ?? {};
    const path = decodePath(rawPath);
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const base = serverUrl(op.servers || item.servers || doc.servers);
      const body = pickContent(op.requestBody?.content);

      if (isTokenRequest(path, method, body)) {
        const tokenUrl = joinUrl(base, path);
        collectVariables(tokenUrl, variables);
        const grant = body?.schema?.properties?.grant_type;
        const isPassword = grant?.default === 'password' || grant?.enum?.includes?.('password');
        auth = isPassword
          ? { type: 'oauth2_password', tokenUrl, username: '', password: '', clientId: '', clientSecret: '', scope: '' }
          : { type: 'oauth2_client_credentials', tokenUrl, clientId: '', clientSecret: '', scope: '' };
        authSource = `${method.toUpperCase()} ${path}`;
        continue;
      }

      const M = method.toUpperCase();
      let url = pathParamsToForm(joinUrl(base, path));
      collectVariables(url, variables);

      const properties = {};
      const required = [];
      const query = {};
      const headers = {};
      const seen = new Set();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])].reverse()) {
        if (!p?.name || seen.has(`${p.in}:${p.name}`)) continue;
        seen.add(`${p.in}:${p.name}`);
        if ((p.in === 'query' || p.in === 'header') && GATEWAY_KEY.test(p.name)) {
          const ref = `{{var:${gatewayKeyVar(p.example ?? p.schema?.default ?? p.schema?.example)}}}`;
          if (p.in === 'query') query[p.name] = ref;
          else headers[p.name] = ref;
        } else if (p.in === 'path' || p.in === 'query') {
          properties[p.name] = { title: p.name, ...toFormSchema(p.schema ?? { type: 'string' }), ...(p.description ? { description: p.description } : {}) };
          if (p.in === 'path' || p.required) required.push(p.name);
          if (p.in === 'query') query[p.name] = `{{form.${p.name}}}`;
        } else if (p.in === 'header' && !/^(authorization|content-type|accept)$/i.test(p.name)) {
          const v = p.example ?? p.schema?.default ?? p.schema?.example;
          if (v !== undefined && v !== '') headers[p.name] = String(v);
          collectVariables(v, variables);
        }
      }

      // the operation's own security, when it differs from the module's sign-in
      let formAuth = { type: 'module' };
      const security = op.security ?? doc.security;
      if (Array.isArray(security)) {
        const names = security.length ? Object.keys(security[0] ?? {}) : [];
        if (!names.length) formAuth = { type: 'none' };
        else {
          if (!names.includes(moduleScheme)) formAuth = { type: 'none' };
          for (const n of names) {
            const sch = schemes[n];
            if (!sch || n === moduleScheme) continue;
            if (sch.type === 'apiKey' && (sch.in === 'header' || sch.in === 'query')) {
              const ref = GATEWAY_KEY.test(sch.name) ? `{{var:${gatewayKeyVar('')}}}` : `{{var:${schemeKeyVar(n)}}}`;
              if (sch.in === 'header') headers[sch.name] = ref;
              else query[sch.name] = ref;
            } else if (formAuth.type === 'none') {
              const own = authFromSecuritySchemes({ [n]: sch });
              if (own) formAuth = own;
              else warnings.push(`${M} ${path}: its "${n}" sign-in cannot be imported; set the form's sign-in by hand.`);
            }
          }
        }
      }

      const api = { method: M, url };
      if (Object.keys(query).length) api.query = query;
      if (Object.keys(headers).length) api.headers = headers;

      let formSchema;

      if (body?.schema && /"format":"binary"/.test(JSON.stringify(body.schema))) {
        warnings.push(`${M} ${path}: the API takes a file upload. Files cannot be sent from a form; the other fields were imported.`);
      }
      let uiSchema;
      const textBody = body?.type && /xml|^text\//i.test(body.type) && !['GET', 'DELETE'].includes(M);
      if (textBody) {
        // XML or plain text: one box with the body, sent as typed with its own Content-Type
        properties.body = { type: 'string', title: 'Body', ...(typeof body.example === 'string' ? { default: body.example } : {}) };
        api.bodyTemplate = '{{form.body}}';
        api.bodyType = 'text';
        api.headers = { ...api.headers, 'Content-Type': body.type };
        uiSchema = { body: { 'ui:widget': 'textarea', 'ui:options': { rows: 8 } } };
        warnings.push(`${M} ${path}: the API takes ${body.type}. The form has one box for the body, sent as it is typed.`);
      }
      // a JSON body the file does not describe (no schema, no example, or an object without fields): one box to paste it in
      const looseBody =
        body?.type && !textBody && body.bodyType === 'json' && !['GET', 'DELETE'].includes(M) &&
        (!body.schema || (() => {
          const f = toFormSchema(body.schema);
          return (f.type === 'object' || !f.type) && !Object.keys(f.properties ?? {}).length && !f.items && !f.oneOf && !f.anyOf;
        })());
      if (looseBody) {
        properties.body = {
          type: 'string',
          title: 'Body (JSON)',
          description: 'The file does not describe this body. Paste the JSON to send.',
          ...(body.example && typeof body.example === 'object' ? { default: JSON.stringify(body.example, null, 2) } : {}),
        };
        api.bodyTemplate = '{{form.body | json}}';
        uiSchema = { body: { 'ui:widget': 'textarea', 'ui:options': { rows: 10 } } };
        warnings.push(`${M} ${path}: the file does not describe the body, so the form has one box to paste the JSON in.`);
      }
      if (body?.schema && !textBody && !looseBody && !['GET', 'DELETE'].includes(M)) {
        const bodySchema = toFormSchema(body.schema);
        // the example in the file fills the form, so a request can be sent as it was tested
        const hasExample = body.example && typeof body.example === 'object';
        if (hasExample) applySampleDefaults(bodySchema, body.example);
        const empty = hasExample ? emptySkeleton(body.example) : undefined;
        if (body.bodyType === 'form') api.bodyType = 'form';
        const isObject = bodySchema.type === 'object' || bodySchema.properties;
        if (isObject && !Object.keys(properties).length) {
          formSchema = { ...bodySchema, type: 'object' }; // body = form data as-is
          if (empty) {
            api.sendEmptyFields = true;
            api.emptyFields = empty;
          }
        } else if (isObject) {
          // parameters + body fields on one form: body is built from the body fields only
          const bodyTemplate = {};
          for (const [k, v] of Object.entries(bodySchema.properties ?? {})) {
            const key = properties[k] ? `${k}_body` : k;
            properties[key] = v;
            bodyTemplate[k] = `{{form.${key}}}`;
          }
          required.push(...(bodySchema.required ?? []).map((k) => (bodyTemplate[k] === `{{form.${k}}}` ? k : `${k}_body`)));
          api.bodyTemplate = bodyTemplate;
        } else {
          properties.body = { title: 'Body', ...bodySchema };
          api.bodyTemplate = '{{form.body}}';
        }
      }
      if (!formSchema) {
        formSchema = { type: 'object', properties };
        if (required.length) formSchema.required = [...new Set(required)];
      }

      const name = String(op.summary || op.operationId || `${M} ${path}`).trim().slice(0, 200);
      requests.push({
        key: `${M} ${path}`,
        name,
        method: M,
        url,
        fieldCount: Object.keys(formSchema.properties ?? {}).length,
        definition: {
          name,
          ...(op.description ? { description: String(op.description).slice(0, 2000) } : {}),
          icon: ICON_BY_METHOD[M],
          ...(String(op.tags?.[0] ?? '').trim() ? { group: String(op.tags[0]).trim().slice(0, 60) } : {}),
          auth: formAuth,
          api,
          source: { format: 'openapi', ...(op.operationId ? { operationId: String(op.operationId) } : {}), method: M, path },
          formSchema,
          ...(uiSchema ? { uiSchema } : {}),
        },
      });
    }
  }

  if (!auth) {
    auth = authFromSecuritySchemes(moduleScheme ? { [moduleScheme]: schemes[moduleScheme] } : schemes, doc.security);
    if (auth) authSource = 'securitySchemes';
  }
  for (const v of Object.values(auth ?? {})) collectVariables(v, variables);
  if (variables.has('baseUrl') && !(doc.servers ?? []).some((s) => /^(https?:)?\/\//i.test(String(s?.url ?? '')))) {
    warnings.unshift('The file has no full server address. Set the module variable "baseUrl" (for example https://api.example.com) before running the forms.');
    if (!('baseUrl' in variableValues)) variableValues.baseUrl = '';
  }
  for (const ref of missingRefs) {
    warnings.push(
      String(ref).startsWith('#/')
        ? `The file refers to ${ref}, which it does not contain. Fields that use it are left empty.`
        : `The file refers to another file (${ref}). Only references inside the same file can be read; fields that use it are left empty.`,
    );
  }

  const name = String(moduleName || doc.info?.title || 'Imported API').trim().slice(0, 60);
  return { moduleName: name, auth: auth ?? { type: 'none' }, authSource, variables: [...variables], variableValues, requests, warnings };
}
