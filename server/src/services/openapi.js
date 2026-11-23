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
  if (doc.swagger) throw new ImportError('Swagger 2.0 files are not supported. Export or convert the file to OpenAPI 3.');
  if (!String(doc.openapi ?? '').startsWith('3')) throw new ImportError('The file has no "openapi: 3.x" line, so it is not an OpenAPI 3 document.');
  if (!doc.paths || typeof doc.paths !== 'object' || !Object.keys(doc.paths).length) throw new ImportError('The file has no requests (paths).');
  return doc;
}

/* ---------------- $ref ---------------- */

function makeResolver(doc) {
  const lookup = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined; // external refs are not supported
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

function serverUrl(servers) {
  const s = servers?.[0];
  if (!s?.url) return '';
  return s.url
    .replace(/\{(\w+)\}/g, (m, name) => s.variables?.[name]?.default ?? m)
    .replace(/\/+$/, '');
}

const VARIABLE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
function collectVariables(text, into) {
  for (const m of String(text ?? '').matchAll(VARIABLE)) into.add(m[1]);
}

/** {customerId} (OpenAPI path parameter) -> {{form.customerId}}; {{tenantId}} (Postman variable) is kept. */
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
  return { type, bodyType: type === 'application/x-www-form-urlencoded' ? 'form' : 'json', schema: schema ?? null };
}

const isTokenRequest = (path, method, body) =>
  method === 'post' &&
  (/\/oauth2(\/v2\.0)?\/token\/?$/i.test(path) || Boolean(body?.schema?.properties?.grant_type));

function authFromSecuritySchemes(schemes) {
  for (const s of Object.values(schemes ?? {})) {
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
  const deref = makeResolver(doc);
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
        const tokenUrl = `${base}${path}`;
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
      let url = pathParamsToForm(`${base}${path}`);
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

      const api = { method: M, url };
      if (Object.keys(query).length) api.query = query;
      if (Object.keys(headers).length) api.headers = headers;

      let formSchema;
      if (body?.schema && !['GET', 'DELETE'].includes(M)) {
        const bodySchema = toFormSchema(body.schema);
        if (body.bodyType === 'form') api.bodyType = 'form';
        const isObject = bodySchema.type === 'object' || bodySchema.properties;
        if (isObject && !Object.keys(properties).length) {
          formSchema = { ...bodySchema, type: 'object' }; // body = form data as-is
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
          auth: { type: 'module' },
          api,
          source: { format: 'openapi', ...(op.operationId ? { operationId: String(op.operationId) } : {}), method: M, path },
          formSchema,
        },
      });
    }
  }

  if (!auth) {
    auth = authFromSecuritySchemes(deref(doc.components?.securitySchemes));
    if (auth) authSource = 'securitySchemes';
  }
  for (const v of Object.values(auth ?? {})) collectVariables(v, variables);

  const name = String(moduleName || doc.info?.title || 'Imported API').trim().slice(0, 60);
  return { moduleName: name, auth: auth ?? { type: 'none' }, authSource, variables: [...variables], variableValues, requests };
}
