/**
 * Tiny template engine used inside schema definitions.
 *
 *   {{env:FNO_CLIENT_SECRET}}            -> value from server environment (.env / app settings)
 *   {{kv:fno-client-secret}}             -> secret from Azure Key Vault (loaded before resolving)
 *   {{form.CustomerAccount}}             -> value the user typed in the form
 *   {{form}}                             -> the whole form data object
 *   {{response.SalesOrderNumber}}        -> (successMessage only) value from the API response
 *   {{form.RequestedReceiptDate | datetime}}  -> with a filter
 *   {{tenantId}} or {{var:tenantId}}     -> variable of the form's module (like Postman collection variables)
 *
 * If a string is ONLY one placeholder, the raw value is returned (numbers stay
 * numbers, objects stay objects). Otherwise placeholders are joined as text.
 * Keys whose value resolves to `undefined` are dropped from objects, so empty
 * optional fields are simply not sent to the API.
 */

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;
const SINGLE = /^\{\{\s*([^}]+?)\s*\}\}$/;

export class TemplateError extends Error {}

const filters = {
  // "2026-11-20" -> "2026-11-20T12:00:00Z"  (F&O Edm.DateTimeOffset fields)
  datetime: (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00Z`;
    return new Date(s).toISOString();
  },
  date: (v) => (v ? String(v).slice(0, 10) : undefined),
  number: (v) => (v === undefined || v === null || v === '' ? undefined : Number(v)),
  string: (v) => (v === undefined || v === null ? undefined : String(v)),
  boolean: (v) => (v === undefined ? undefined : v === true || v === 'true' || v === 'Yes'),
  upper: (v) => (v == null ? v : String(v).toUpperCase()),
  lower: (v) => (v == null ? v : String(v).toLowerCase()),
  trim: (v) => (v == null ? v : String(v).trim()),
};

function getPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function evaluate(expr, ctx) {
  const [source, ...filterNames] = expr.split('|').map((s) => s.trim());
  let value;

  if (source.startsWith('env:')) {
    const name = source.slice(4).trim();
    value = ctx.env?.[name];
    if (value === undefined || value === '') {
      throw new TemplateError(`Environment variable "${name}" is not set on the server (.env).`);
    }
  } else if (source.startsWith('kv:')) {
    const name = source.slice(3).trim();
    value = ctx.kv?.[name];
    if (value === undefined) throw new TemplateError(`Key Vault secret "${name}" was not loaded.`);
  } else if (source === 'form' || source.startsWith('form.')) {
    value = getPath(ctx.form ?? {}, source === 'form' ? '' : source.slice(5));
  } else if (source === 'response' || source.startsWith('response.')) {
    value = getPath(ctx.response ?? {}, source === 'response' ? '' : source.slice(9));
  } else if (source === 'token') {
    value = ctx.token;
  } else if (source.startsWith('var:') || /^[A-Za-z_][\w-]*$/.test(source)) {
    const name = source.startsWith('var:') ? source.slice(4).trim() : source;
    value = ctx.vars?.[name];
    if (value === undefined || value === '') {
      throw new TemplateError(`Variable "${name}" has no value. Set it in the module's sign-in settings.`);
    }
  } else {
    throw new TemplateError(`Unknown placeholder "{{${expr}}}". Use env:, kv:, form., response., token or a module variable.`);
  }

  for (const f of filterNames) {
    const fn = filters[f];
    if (!fn) throw new TemplateError(`Unknown filter "${f}" in "{{${expr}}}".`);
    value = fn(value);
  }
  return value;
}

export function resolveString(str, ctx) {
  const single = str.match(SINGLE);
  if (single) return evaluate(single[1], ctx);
  return str.replace(PLACEHOLDER, (_, expr) => {
    const v = evaluate(expr, ctx);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function resolveDeep(value, ctx) {
  if (typeof value === 'string') return resolveString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, ctx)).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveDeep(v, ctx);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}
