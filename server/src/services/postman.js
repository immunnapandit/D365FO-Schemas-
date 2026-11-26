import { d365ListFromRequest } from './odata-import.js';
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

const isVariable = (v) => {
  VARIABLE.lastIndex = 0;
  const hit = typeof v === 'string' && VARIABLE.test(v);
  VARIABLE.lastIndex = 0;
  return hit;
};

/** A sample value without nulls, {{variables}} and @odata keys, so it can prefill a list of rows. */
export function sampleRows(v) {
  if (Array.isArray(v)) return v.map(sampleRows).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('@')) continue;
      const c = sampleRows(x);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return v === null || v === undefined || isVariable(v) ? undefined : v;
}

/**
 * Keys whose sample value is "" or null, with that value, keeping the nesting (a list keeps its first row).
 * Lets a form send blank fields the way the sample (and Postman) does. Undefined when there are none.
 */
export function emptySkeleton(v) {
  if (Array.isArray(v)) {
    const s = v.length ? emptySkeleton(v[0]) : undefined;
    return s === undefined ? undefined : [s];
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('@')) continue;
      if (x === '' || x === null) out[k] = x;
      else if (typeof x === 'object') {
        const s = emptySkeleton(x);
        if (s !== undefined) out[k] = s;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

/**
 * Schema from a sample body; sample values become default values (except {{variables}} and nulls).
 * A list (e.g. invoices with their lineItems) is prefilled with the sample rows, which can then be
 * changed, removed or added to in the form.
 */
function schemaWithDefaults(value) {
  const schema = inferSchema(value);
  applySampleDefaults(schema, value);
  return schema;
}

/** Field names whose sample value must not become a visible default (passwords and keys in test files). */
const SECRET_FIELD = /pass(word|wd)?$|secret|token|api_?key|subscription_?key|^authorization$/i;

/** Puts the values of a sample (Postman body, OpenAPI example) into a schema as default values, in place. */
export function applySampleDefaults(s, v) {
  if (!s || typeof s !== 'object') return s;
  if ((s.type === 'object' || s.properties) && v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, sub] of Object.entries(s.properties ?? {})) {
      if (!SECRET_FIELD.test(k)) applySampleDefaults(sub, v[k]);
    }
  } else if (s.type === 'array') {
    if (Array.isArray(v) && v.length) s.default = sampleRows(v);
  } else if (s.type !== 'object' && v !== null && v !== undefined && typeof v !== 'object' && !isVariable(v)) {
    s.default = v;
    if (typeof v === 'string' && /^\s*\{\{\s*\$(guid|randomUUID|timestamp|isoTimestamp|randomInt)\s*\}\}\s*$/.test(v) && !s.description) {
      s.description = 'A new value is made on each submit.';
    }
  }
  return s;
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

/** Flattens folders; requests keep their own name and remember their top-level folder (the group in the menu). */
/** Requests in file order, with their top-level folder (the group) and the sign-in a folder sets for them. */
function flatten(items, out = [], folder = undefined, folderAuth = undefined) {
  for (const it of items ?? []) {
    if (Array.isArray(it?.item)) {
      const own = it.auth && it.auth.type && it.auth.type !== 'inherit' ? it.auth : folderAuth;
      flatten(it.item, out, folder ?? (String(it.name ?? '').trim() || undefined), own);
    } else if (it?.request) out.push({ item: it, folder, folderAuth });
  }
  return out;
}

const RAW_CONTENT_TYPE = { xml: 'application/xml', html: 'text/html', text: 'text/plain', javascript: 'application/javascript' };

/** A body value that is only a collection variable ({{company}}, defined in the file): sent from the module, not typed on the form. */
const MODULE_VALUE = /^\s*\{\{\s*(?!\$)[^{}]+\}\}\s*$/;

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
  const warnings = [];

  /** A secret from a request's own sign-in goes to an (encrypted) module variable; the form refers to it. */
  const secretByValue = new Map();
  const secretVar = (base, value) => {
    const v = String(value ?? '');
    if (/^\s*\{\{[^}]+\}\}\s*$/.test(v)) {
      collectVariables(v, variables);
      return v.trim();
    }
    const known = secretByValue.get(`${base}\u0000${v}`);
    if (known) return `{{${known}}}`;
    let name = base;
    for (let i = 2; variables.has(name); i += 1) name = `${base}${i}`;
    variables.add(name);
    variableValues[name] = v;
    secretByValue.set(`${base}\u0000${v}`, name);
    return `{{${name}}}`;
  };
  const collectionAuth = JSON.stringify(doc.auth ?? null);

  for (const { item: it, folder, folderAuth } of flatten(doc.item)) {
    const req = typeof it.request === 'string' ? { method: 'GET', url: it.request } : it.request;
    const M = String(req.method || 'GET').toUpperCase();
    const fullUrl = rawUrl(req.url).trim();
    const body = req.body;
    if (!fullUrl) {
      warnings.push(`"${it.name || 'Unnamed request'}" has no URL and was skipped.`);
      continue;
    }

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

    // the request's own sign-in (or its folder's), when it differs from the collection's
    let formAuth = { type: 'module' };
    const ownRaw = req.auth && req.auth.type && req.auth.type !== 'inherit' ? req.auth : folderAuth;
    if (ownRaw && JSON.stringify(ownRaw) !== collectionAuth) {
      const p = authParams(ownRaw[ownRaw.type]);
      if (ownRaw.type === 'apikey' && p.in === 'query') {
        query[p.key || 'api_key'] = secretVar('apiKey', p.value);
        formAuth = { type: 'none' };
      } else {
        const own = postmanAuth(ownRaw);
        if (!own) warnings.push(`"${it.name}" uses a "${ownRaw.type}" sign-in that cannot be imported; it uses the module's sign-in.`);
        else if (own.type === 'none') formAuth = { type: 'none' };
        else if (own.type === 'basic') formAuth = { type: 'basic', username: own.username, password: secretVar('basicPassword', own.password) };
        else if (own.type === 'bearer_static') formAuth = { type: 'bearer_static', token: secretVar('bearerToken', own.token) };
        else if (own.type === 'api_key') formAuth = { type: 'api_key', headerName: own.headerName, value: secretVar('apiKey', own.value) };
        else {
          formAuth = { ...own, ...(own.clientSecret ? { clientSecret: secretVar('clientSecret', own.clientSecret) } : {}), ...(own.password ? { password: secretVar('password', own.password) } : {}) };
          collectVariables(own.tokenUrl, variables);
        }
      }
    }

    const api = { method: M, url };
    // a D365 entity list (GET …/data/CustomersV3?$filter=…): filters on screen instead of a fixed query
    const d365List = d365ListFromRequest(M, base, query);
    if (d365List) {
      for (const k of Object.keys(query)) delete query[k];
      Object.assign(query, d365List.query);
      api.odata = d365List.odata;
    }
    if (Object.keys(query).length) api.query = query;
    if (Object.keys(headers).length) api.headers = headers;

    let formSchema;
    let uiSchema;
    if (body && !['GET', 'DELETE'].includes(M)) {
      let bodySchema = null;
      let empty;
      if (body.mode === 'raw' && body.raw && String(body.raw).trim()) {
        const parsed = parseJsonBody(body.raw);
        if (parsed && typeof parsed === 'object') {
          bodySchema = schemaWithDefaults(parsed);
          empty = emptySkeleton(parsed);
        }
        else {
          // XML, text…: one box with the body, sent as it is with its own Content-Type
          properties.body = { type: 'string', title: 'Body', default: String(body.raw) };
          api.bodyTemplate = '{{form.body}}';
          api.bodyType = 'text';
          const typed = (req.header ?? []).find((h) => h?.key && !h.disabled && /^content-type$/i.test(h.key));
          const lang = body.options?.raw?.language;
          const contentType = typed?.value || RAW_CONTENT_TYPE[lang] || (/^\s*</.test(String(body.raw)) ? 'application/xml' : 'text/plain');
          api.headers = { ...api.headers, 'Content-Type': String(contentType) };
          uiSchema = { body: { 'ui:widget': 'textarea', 'ui:options': { rows: 8 } } };
        }
      } else if (body.mode === 'graphql' && body.graphql?.query) {
        // a GraphQL call is a JSON body { query, variables }
        const vars = parseJsonBody(body.graphql.variables || '') ?? {};
        const parsed = { query: String(body.graphql.query), variables: vars && typeof vars === 'object' ? vars : {} };
        bodySchema = schemaWithDefaults(parsed);
      } else if (['urlencoded', 'formdata'].includes(body.mode)) {
        if (body.mode === 'formdata' && (body.formdata ?? []).some((p) => p?.type === 'file' && !p.disabled)) {
          warnings.push(`"${it.name}" sends a file. Files cannot be sent from a form; the other fields were imported.`);
        }
        const sample = Object.fromEntries((body[body.mode] ?? []).filter((p) => p?.key && !p.disabled && p.type !== 'file').map((p) => [p.key, String(p.value ?? '')]));
        bodySchema = schemaWithDefaults(sample);
        api.bodyType = 'form';
      }
      // top-level body values that are only a module variable stay out of the form and are sent from the module
      const fixed = {};
      if (bodySchema?.type === 'object' && body.mode === 'raw') {
        const parsed = parseJsonBody(body.raw);
        for (const [k, v] of Object.entries(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})) {
          // only variables the collection defines: their value is in the module. Others are typed on the form.
          if (typeof v === 'string' && MODULE_VALUE.test(v) && v.replace(/[{}\s]/g, '') in variableValues) {
            fixed[k] = v.trim();
            delete bodySchema.properties?.[k];
            if (bodySchema.required) bodySchema.required = bodySchema.required.filter((r) => r !== k);
            if (empty && typeof empty === 'object') delete empty[k];
            collectVariables(v, variables);
          }
        }
      }
      const hasFixed = Object.keys(fixed).length > 0;
      if (bodySchema) {
        const isObject = bodySchema.type === 'object';
        let emptyFields = empty;
        if (isObject && !Object.keys(properties).length && !hasFixed) {
          formSchema = bodySchema; // body = form data as-is
        } else if (isObject) {
          const bodyTemplate = {};
          const renamed = {};
          for (const [k, v] of Object.entries(bodySchema.properties ?? {})) {
            const key = properties[k] ? `${k}_body` : k;
            properties[key] = v;
            bodyTemplate[k] = `{{form.${key}}}`;
            if (empty && k in empty) renamed[key] = empty[k];
          }
          Object.assign(bodyTemplate, fixed);
          api.bodyTemplate = bodyTemplate;
          emptyFields = Object.keys(renamed).length ? renamed : undefined;
        } else {
          properties.body = { title: 'Body', ...bodySchema };
          api.bodyTemplate = '{{form.body}}';
          emptyFields = empty === undefined ? undefined : { body: empty };
        }
        // the sample sends blank fields as "" / null: send them the same way (can be switched off on the form)
        if (emptyFields) {
          api.sendEmptyFields = true;
          api.emptyFields = emptyFields;
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
        ...(folder ? { group: folder.slice(0, 60) } : {}),
        auth: formAuth,
        api,
        source: { format: 'postman', method: M, path: base },
        formSchema,
        ...(uiSchema ? { uiSchema } : {}),
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
    warnings,
  };
}

export { ImportError };
