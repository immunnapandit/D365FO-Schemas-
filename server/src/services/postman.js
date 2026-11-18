import { ImportError, inferSchema } from './openapi.js';

/**
 * Turns a Postman collection (v2.0 / v2.1 export, JSON) into one module and one form per request,
 * the same plan the OpenAPI import produces.
 *
 * - The collection's Authorization (OAuth 2.0, basic, bearer, API key) becomes the module's sign-in,
 *   with the values the export contains (token URL, client ID, scope, …).
 * - Collection variables ({{baseUrl}}, {{tenantId}}, …) become module variables, with their values.
 * - A "get token" request in the collection is not a form; it becomes the sign-in when the collection has none.
 * - The JSON body of each request becomes the form; its sample values are the fields' default values.
 */

export const isPostmanCollection = (doc) =>
  Boolean(doc?.info?._postman_id || String(doc?.info?.schema ?? '').includes('getpostman')) && Array.isArray(doc?.item);

const VARIABLE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
function collectVariables(value, into) {
  if (value === null || value === undefined) return;
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectVariables(v, into);
    return;
  }
  for (const m of String(value).matchAll(VARIABLE)) into.add(m[1]);
}

/** Postman stores auth settings as [{ key, value }]. */
function authParams(list) {
  if (!Array.isArray(list)) return {};
  return Object.fromEntries(list.filter((p) => p && p.key).map((p) => [p.key, p.value === undefined || p.value === null ? '' : String(p.value)]));
}

/** Postman auth -> our sign-in. Unknown kinds give null (the admin sets the sign-in on the module). */
export function postmanAuth(auth) {
  if (!auth || !auth.type || auth.type === 'inherit') return null;
  const p = authParams(auth[auth.type]);
  switch (auth.type) {
    case 'noauth':
      return { type: 'none' };
    case 'oauth2': {
      const grant = p.grant_type || 'client_credentials';
      const common = {
        tokenUrl: p.accessTokenUrl || '',
        clientId: p.clientId || '',
        clientSecret: p.clientSecret || '',
        scope: p.scope || '',
      };
      if (grant === 'password_credentials') return { type: 'oauth2_password', ...common, username: p.username || '', password: p.password || '' };
      return { type: 'oauth2_client_credentials', ...common };
    }
    case 'basic':
      return { type: 'basic', username: p.username || '', password: p.password || '' };
    case 'bearer':
      return { type: 'bearer_static', token: p.token || '' };
    case 'apikey':
      if (p.in === 'query') return null;
      return { type: 'api_key', headerName: p.key || 'Authorization', value: p.value || '' };
    default:
      return null;
  }
}

const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));

function rawUrl(url) {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (url.raw) return url.raw;
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
  const path = Array.isArray(url.path) ? url.path.join('/') : url.path || '';
  return `${url.protocol ? `${url.protocol}://` : ''}${host}${path ? `/${path}` : ''}`;
}

/** Parses a raw JSON body that may contain unquoted {{variables}}. */
function parseJsonBody(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(String(raw).replace(/(?<!")\{\{\s*[\w-]+\s*\}\}(?!")/g, 'null'));
    } catch {
      return undefined;
    }
  }
}

/** Schema from a sample body; sample values become default values (except {{variables}} and nulls). */
function schemaWithDefaults(value) {
  const schema = inferSchema(value);
  const addDefaults = (s, v) => {
    if (s.type === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, sub] of Object.entries(s.properties ?? {})) addDefaults(sub, v[k]);
    } else if (s.type !== 'array' && s.type !== 'object' && v !== null && v !== undefined && !(typeof v === 'string' && VARIABLE.test(v))) {
      s.default = v;
    }
    VARIABLE.lastIndex = 0;
  };
  addDefaults(schema, value);
  return schema;
}

const isTokenRequest = (method, url, body) =>
  method === 'POST' &&
  (/\/oauth2(\/v2\.0)?\/token\/?(\?|$)/i.test(url) ||
    (['urlencoded', 'formdata'].includes(body?.mode) && (body[body.mode] ?? []).some((p) => p?.key === 'grant_type')));

/** Sign-in from a "Get token" request of the collection (client credentials or password grant). */
function authFromTokenRequest(url, body) {
  const p = Object.fromEntries((body?.[body?.mode] ?? []).filter((x) => x?.key && !x.disabled).map((x) => [x.key, String(x.value ?? '')]));
  const common = { tokenUrl: url.split('?')[0], clientId: p.client_id || '', clientSecret: p.client_secret || '', scope: p.scope || '' };
  if (p.grant_type === 'password') return { type: 'oauth2_password', ...common, username: p.username || '', password: p.password || '' };
  return { type: 'oauth2_client_credentials', ...common };
}

function description(d) {
  if (!d) return undefined;
  const text = typeof d === 'string' ? d : d.content;
  return text ? String(text).slice(0, 2000) : undefined;
}

const ICON_BY_METHOD = { GET: 'globe', POST: 'document', PUT: 'document', PATCH: 'document', DELETE: 'document' };

/** Flattens folders; requests inside folders keep their own name. */
function flatten(items, out = []) {
  for (const it of items ?? []) {
    if (Array.isArray(it?.item)) flatten(it.item, out);
    else if (it?.request) out.push(it);
  }
  return out;
}

export function buildPostmanPlan(doc, { moduleName } = {}) {
  const variables = new Set();
  const variableValues = {};
  for (const v of doc.variable ?? []) {
    if (!v?.key || v.disabled) continue;
    variables.add(v.key);
    variableValues[v.key] = v.value === undefined || v.value === null ? '' : String(v.value);
  }

  let auth = postmanAuth(doc.auth);
  let authSource = auth ? 'collection' : null;
  const requests = [];
  const usedNames = new Set();

  for (const it of flatten(doc.item)) {
    const req = typeof it.request === 'string' ? { method: 'GET', url: it.request } : it.request;
    const M = String(req.method || 'GET').toUpperCase();
    const fullUrl = rawUrl(req.url).trim();
    const body = req.body;

    if (isTokenRequest(M, fullUrl, body)) {
      if (!auth || auth.type === 'none') {
        auth = authFromTokenRequest(fullUrl, body);
        authSource = `request "${it.name}"`;
      }
      continue;
    }

    // query string: fixed values stay on the request; :pathVariables become fields
    const [base] = fullUrl.split('?');
    const query = {};
    const queryList = typeof req.url === 'object' && Array.isArray(req.url.query) ? req.url.query : [];
    for (const q of queryList) if (q?.key && !q.disabled) query[q.key] = String(q.value ?? '');
    if (!queryList.length && fullUrl.includes('?')) {
      for (const [k, v] of new URLSearchParams(fullUrl.split('?')[1])) query[k] = v;
    }

    const properties = {};
    const required = [];
    const url = base.replace(/(^|\/):([A-Za-z_][\w-]*)/g, (m, slash, name) => {
      properties[name] = { type: 'string', title: name };
      required.push(name);
      return `${slash}{{form.${name}}}`;
    });
    collectVariables(url, variables);
    collectVariables(query, variables);

    const headers = {};
    for (const h of req.header ?? []) {
      if (!h?.key || h.disabled || /^(authorization|content-type|accept|content-length)$/i.test(h.key)) continue;
      headers[h.key] = String(h.value ?? '');
    }
    collectVariables(headers, variables);

    const api = { method: M, url };
    if (Object.keys(query).length) api.query = query;
    if (Object.keys(headers).length) api.headers = headers;

    let formSchema;
    if (body && !['GET', 'DELETE'].includes(M)) {
      let bodySchema = null;
      if (body.mode === 'raw' && body.raw && String(body.raw).trim()) {
        const parsed = parseJsonBody(body.raw);
        if (parsed && typeof parsed === 'object') bodySchema = schemaWithDefaults(parsed);
        else {
          properties.body = { type: 'string', title: 'Body', default: String(body.raw) };
          api.bodyTemplate = '{{form.body}}';
        }
      } else if (['urlencoded', 'formdata'].includes(body.mode)) {
        const sample = Object.fromEntries((body[body.mode] ?? []).filter((p) => p?.key && !p.disabled && p.type !== 'file').map((p) => [p.key, String(p.value ?? '')]));
        bodySchema = schemaWithDefaults(sample);
        api.bodyType = 'form';
      }
      if (bodySchema) {
        const isObject = bodySchema.type === 'object';
        if (isObject && !Object.keys(properties).length) {
          formSchema = bodySchema; // body = form data as-is
        } else if (isObject) {
          const bodyTemplate = {};
          for (const [k, v] of Object.entries(bodySchema.properties ?? {})) {
            const key = properties[k] ? `${k}_body` : k;
            properties[key] = v;
            bodyTemplate[k] = `{{form.${key}}}`;
          }
          api.bodyTemplate = bodyTemplate;
        } else {
          properties.body = { title: 'Body', ...bodySchema };
          api.bodyTemplate = '{{form.body}}';
        }
      }
    }
    if (!formSchema) {
      formSchema = { type: 'object', properties };
      if (required.length) formSchema.required = [...new Set(required)];
    }

    let name = String(it.name || `${M} ${base}`).trim().slice(0, 200);
    for (let i = 2; usedNames.has(name.toLowerCase()); i += 1) name = `${String(it.name).slice(0, 195)} (${i})`;
    usedNames.add(name.toLowerCase());

    requests.push({
      key: `${M} ${base} #${requests.length + 1}`,
      name,
      method: M,
      url,
      fieldCount: Object.keys(formSchema.properties ?? {}).length,
      definition: {
        name,
        ...(description(req.description ?? it.description) ? { description: description(req.description ?? it.description) } : {}),
        icon: ICON_BY_METHOD[M] ?? 'document',
        auth: { type: 'module' },
        api,
        source: { format: 'postman', method: M, path: base },
        formSchema,
      },
    });
  }

  collectVariables(auth, variables);
  const moduleNameOut = String(moduleName || doc.info?.name || 'Imported collection').trim().slice(0, 60);
  return {
    moduleName: moduleNameOut,
    format: 'postman',
    auth: auth ? strip(auth) : { type: 'none' },
    authSource,
    variables: [...variables],
    variableValues,
    requests,
  };
}

export { ImportError };
