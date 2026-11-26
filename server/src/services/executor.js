import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { DYNAMIC, resolveDeep, resolveString } from './template.js';
import { getAuthHeaders } from './outbound-auth.js';
import { httpRequest } from './http.js';
import { StageError, normalizeApiError } from './errors.js';
import { resolveKvRefs } from './keyvault.js';
import { buildODataQuery } from './odata.js';

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE']);
const IDEMPOTENT = new Set(['GET', 'PUT', 'DELETE']); // safe to retry; POST/PATCH are not (could create duplicates)

/* ---------- form data validation (compiled validators cached per form version) ---------- */

const validators = new Map();
function getValidator(form) {
  const key = `${form.id}@${form.version}`;
  let v = validators.get(key);
  if (!v) {
    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: true });
    addFormats(ajv);
    v = ajv.compile(form.formSchema);
    validators.set(key, v);
    if (validators.size > 300) validators.delete(validators.keys().next().value);
  }
  return v;
}

function validateForm(form, formData) {
  if (!form.formSchema) return formData ?? {};
  const data = structuredClone(formData ?? {});
  const validate = getValidator(form);
  if (!validate(data)) {
    const details = validate.errors.map((e) => {
      const parent = e.instancePath.replace(/^\//, '').replace(/\//g, '.');
      if (e.keyword === 'required') return `${parent ? `${parent}.` : ''}${e.params.missingProperty}: is required`;
      return `${parent || 'form'}: ${e.message}`;
    });
    throw new StageError('validation', 'Form data is not valid.', { details });
  }
  return data;
}

/** Remove empty strings / null so optional fields the user left blank are not sent. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = clean(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return value === '' || value === null ? undefined : value;
}

/**
 * Puts blank fields back with the sample's value ("" or null) where the form left them out.
 * A list applies its row pattern to every row; fields the user filled in are never changed.
 */
export function fillEmpty(data, pattern) {
  if (Array.isArray(pattern)) return Array.isArray(data) ? data.map((row) => fillEmpty(row, pattern[0])) : data;
  if (!pattern || typeof pattern !== 'object' || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = { ...data };
  for (const [k, p] of Object.entries(pattern)) {
    if (p === '' || p === null) {
      if (out[k] === undefined) out[k] = p;
    } else if (out[k] !== undefined) out[k] = fillEmpty(out[k], p);
    else if (!Array.isArray(p)) out[k] = fillEmpty({}, p);
  }
  return out;
}

function errorResult(e, extra = {}) {
  return {
    ok: false,
    stage: e.stage || 'server',
    status: e.status,
    message: e.message,
    code: e.code,
    details: e.details || [],
    response: e.raw,
    ...extra,
  };
}

// What we show the user / store in history must never contain secrets:
// Key Vault values and env vars with secret-looking names are replaced by a mask.
const MASK = '••••••••';
const SECRET_ENV = /secret|password|passwd|token|key|credential/i;
function previewContext(ctx) {
  const env = new Proxy(ctx.env, { get: (t, k) => (typeof k === 'string' && SECRET_ENV.test(k) && t[k] ? MASK : t[k]) });
  const kv = Object.fromEntries(Object.keys(ctx.kv || {}).map((k) => [k, MASK]));
  const vars = Object.fromEntries(Object.entries(ctx.vars || {}).map(([k, v]) => [k, SECRET_ENV.test(k) && v ? MASK : v]));
  return { ...ctx, env, kv, vars };
}

/**
 * Forms imported from OpenAPI (and new forms) use their module's sign-in: auth.type = "module".
 * The module also provides the {{variables}} used in URLs and sign-in fields.
 */
function effective(form, mod) {
  const vars = mod?.variables ?? {};
  if (form.auth?.type !== 'module') return { auth: form.auth, vars };
  if (!mod) {
    throw new StageError(
      'config',
      form.category
        ? `This form uses the sign-in of module "${form.category}", but that module has no sign-in set up yet. Open the module in the sidebar and set it up.`
        : 'This form uses its module\'s sign-in, but it is not in a module. Choose a module on the Details tab.',
    );
  }
  return { auth: mod.auth, vars };
}

/** Variable values may themselves use {{env:NAME}} or {{kv:secret}}. */
function resolveVars(vars, kv) {
  try {
    return resolveDeep(vars, { env: process.env, kv });
  } catch (e) {
    throw new StageError('config', `Module variable: ${e.message}`);
  }
}

/** OData options keep their $ and use %20 for spaces, as OData services expect */
function addODataQuery(url, query) {
  if (!query) return;
  for (const k of Object.keys(query)) url.searchParams.delete(k);
  const extra = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%2C/g, ',')}`).join('&');
  url.search = url.search ? `${url.search}&${extra}` : `?${extra}`;
}

function buildRequest(api, ctx) {
  const method = (api.method || 'POST').toUpperCase();
  try {
    const pctx = previewContext(ctx);
    const url = new URL(resolveString(api.url, ctx));
    for (const [k, v] of Object.entries(resolveDeep(api.query || {}, ctx))) url.searchParams.set(k, String(v));
    addODataQuery(url, ctx.odataQuery);
    const headers = { Accept: 'application/json', ...resolveDeep(ctx.moduleHeaders || {}, ctx), ...resolveDeep(api.headers || {}, ctx) };
    let body;
    const previewUrl = new URL(resolveString(api.url, pctx));
    for (const [k, v] of Object.entries(resolveDeep(api.query || {}, pctx))) previewUrl.searchParams.set(k, String(v));
    addODataQuery(previewUrl, ctx.odataQuery);
    let preview = { method, url: previewUrl.toString() };
    if (!BODYLESS.has(method)) {
      const payload = api.bodyTemplate !== undefined ? resolveDeep(api.bodyTemplate, ctx) : ctx.form;
      if ((api.bodyType || 'json') === 'form') {
        headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
        body = new URLSearchParams(payload).toString();
      } else if (api.bodyType === 'text') {
        // XML, plain text…: sent exactly as typed
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'text/plain';
        body = payload === undefined || payload === null ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload);
      } else {
        headers['Content-Type'] ??= 'application/json';
        body = JSON.stringify(payload);
      }
      preview = { ...preview, body: api.bodyTemplate !== undefined ? resolveDeep(api.bodyTemplate, pctx) : payload };
    }
    return { method, url: url.toString(), headers, body, preview };
  } catch (e) {
    if (e instanceof StageError) throw e;
    throw new StageError('config', `Could not build request: ${e.message}`);
  }
}

/** Only generate the token. Used by the "Test connection" button. */
export async function testAuth(form, mod) {
  const started = Date.now();
  try {
    const { auth, vars: rawVars } = effective(form, mod);
    const kv = await resolveKvRefs(auth, rawVars);
    const vars = resolveVars(rawVars, kv);
    const { info } = await getAuthHeaders(auth, { env: process.env, kv, vars }, { force: true });
    return { ok: true, message: `Authentication OK (${info.type})`, auth: info, durationMs: Date.now() - started };
  } catch (e) {
    return errorResult(e, { durationMs: Date.now() - started });
  }
}

/**
 * Postman/Bruno dynamic variables in form values ({{$guid}}, {{$timestamp}}, ...) get a fresh value on every
 * submit, as in Postman. Only these few names are replaced: other {{...}} text typed by a user is sent as it is.
 */
const DYNAMIC_RE = /\{\{\s*\$(guid|randomUUID|timestamp|isoTimestamp|randomInt)\s*\}\}/g;

export function resolveDynamicValues(v) {
  if (typeof v === 'string') return v.includes('{{') ? v.replace(DYNAMIC_RE, (_, name) => DYNAMIC[name]()) : v;
  if (Array.isArray(v)) return v.map(resolveDynamicValues);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveDynamicValues(x)]));
  return v;
}

/**
 * Lines of a header + lines form (sales order header, then its lines): one request per line, in order, after the
 * header was created. `set` adds values from the header's response, e.g. { "SalesOrderNumber": "{{response.SalesOrderNumber}}" }.
 * Stops at the first line that fails: the ones before it exist, so they are reported.
 */
async function sendLines(spec, rows, ctx, auth) {
  const out = [];
  const pctx = { ...previewContext(ctx), response: ctx.response };
  for (let i = 0; i < rows.length; i += 1) {
    const lctx = { ...ctx, line: rows[i] };
    let request;
    let url;
    let body;
    try {
      url = resolveString(spec.url, lctx);
      body = { ...rows[i], ...resolveDeep(spec.set ?? {}, lctx) };
      request = { method: (spec.method || 'POST').toUpperCase(), url: resolveString(spec.url, { ...pctx, line: rows[i] }), body: { ...rows[i], ...resolveDeep(spec.set ?? {}, { ...pctx, line: rows[i] }) } };
    } catch (e) {
      out.push({ index: i, ok: false, message: `Could not build the line: ${e.message}`, request });
      break;
    }
    const res = await httpRequest(
      'api',
      { url, method: request.method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...resolveDeep(ctx.moduleHeaders || {}, ctx), ...auth.headers }, body: JSON.stringify(body) },
      { retries: 0, timeoutMs: spec.timeoutMs },
    );
    if (!res.ok) {
      const n = normalizeApiError(res.status, res.body);
      out.push({ index: i, ok: false, status: res.status, message: n.message, details: n.details, response: res.body, request });
      break;
    }
    out.push({ index: i, ok: true, status: res.status, response: res.body, request });
  }
  return out;
}

/** form and mod (its module, may be null) = stored definitions with secrets already decrypted */
export async function execute(form, rawFormData, mod = null) {
  const started = Date.now();
  const timings = {};
  let requestPreview;
  let auth; // kept outside try so a failure after sign-in still reports that sign-in worked

  try {
    if (!form.api?.url) throw new StageError('config', 'Schema has no api.url');
    // list forms: the filters chosen on screen come apart from the form fields
    const { $query: listQuery, ...formInput } = rawFormData && typeof rawFormData === 'object' ? rawFormData : {};
    const odataQuery = form.api.odata ? buildODataQuery(form.api.odata, listQuery ?? {}) : undefined;
    let fd = clean(validateForm(form, formInput)) ?? {};
    if (form.api.sendEmptyFields && form.api.emptyFields) fd = fillEmpty(fd, form.api.emptyFields);
    fd = resolveDynamicValues(fd);

    const { auth: authConfig, vars: rawVars } = effective(form, mod);
    const kv = await resolveKvRefs(authConfig, form.api, rawVars, mod?.headers);
    const vars = resolveVars(rawVars, kv);

    // 1) authentication (cached token, refreshed automatically)
    const t0 = Date.now();
    auth = await getAuthHeaders(authConfig, { env: process.env, kv, vars, form: fd });
    timings.authMs = Date.now() - t0;

    // 2) build the request
    // header + lines forms: the header is sent without its lines, each line follows on its own
    const linesKey = form.api.lines?.field;
    const lineRows = linesKey && Array.isArray(fd[linesKey]) ? fd[linesKey] : [];
    const headerData = linesKey ? Object.fromEntries(Object.entries(fd).filter(([k]) => k !== linesKey)) : fd;
    let ctx = { env: process.env, kv, vars, form: headerData, fullForm: fd, token: auth.token, moduleHeaders: mod?.headers, odataQuery };
    let req = buildRequest(form.api, ctx);
    requestPreview = req.preview;
    const retries = IDEMPOTENT.has(req.method) ? 1 : 0;
    const call = () =>
      httpRequest(
        'api',
        { url: req.url, method: req.method, headers: { ...req.headers, ...auth.headers }, body: req.body },
        { retries, timeoutMs: form.api.timeoutMs },
      );

    // 3) call the API
    let res = await call();

    // a cached token can be revoked/expired early -> get a new one and try once more.
    // 401 means the request was not processed, so retrying is safe even for POST.
    if (res.status === 401 && auth.info?.cached) {
      auth = await getAuthHeaders(authConfig, { env: process.env, kv, vars, form: fd }, { force: true });
      ctx = { ...ctx, token: auth.token };
      req = buildRequest(form.api, ctx);
      res = await call();
    }
    timings.apiMs = res.durationMs;

    if (!res.ok) {
      const n = normalizeApiError(res.status, res.body);
      return errorResult(
        new StageError('api', n.message, { status: res.status, details: n.details, code: n.code, raw: res.body }),
        { request: requestPreview, auth: auth.info, timings, durationMs: Date.now() - started },
      );
    }

    let lines;
    if (linesKey && lineRows.length) {
      lines = await sendLines(form.api.lines, lineRows, { ...ctx, form: fd, response: res.body ?? {} }, auth);
      requestPreview = { ...requestPreview, lines: lines.map((l) => l.request) };
      const failed = lines.find((l) => !l.ok);
      if (failed) {
        const done = lines.filter((l) => l.ok).length;
        let header = 'The header was created';
        if (form.api.successMessage) {
          try {
            header = resolveString(form.api.successMessage, { ...previewContext(ctx), env: {}, kv: {}, response: res.body ?? {} }).replace(/\.$/, '');
          } catch {
            /* keep default */
          }
        }
        return errorResult(
          new StageError('api', `${header}, but line ${failed.index + 1} of ${lineRows.length} failed: ${failed.message}`, {
            status: failed.status,
            details: [
              done ? `${done} line${done === 1 ? ' was' : 's were'} created before it.` : 'No line was created.',
              'Lines after it were not sent. Fix the line and add it, and the ones after it, to the document.',
              ...(failed.details ?? []),
            ],
            raw: failed.response,
          }),
          {
            request: requestPreview,
            response: { header: res.body, lines: lines.map(({ request: _r, ...l }) => l) },
            lines: lines.map(({ request: _r, response: _b, ...l }) => l),
            auth: auth.info,
            timings,
            durationMs: Date.now() - started,
          },
        );
      }
    }

    let message = `Success (HTTP ${res.status})`;
    if (form.api.odata && Array.isArray(res.body?.value)) {
      const n = res.body.value.length;
      const total = Number(res.body['@odata.count']);
      message = `${n} record${n === 1 ? '' : 's'} loaded${Number.isFinite(total) && total > n ? ` (of ${total})` : ''}.`;
    }
    if (form.api.successMessage) {
      try {
        message = resolveString(form.api.successMessage, { ...previewContext(ctx), env: {}, kv: {}, response: res.body ?? {} });
      } catch {
        /* keep default */
      }
    }
    return {
      ok: true,
      status: res.status,
      message,
      request: requestPreview,
      response: res.body,
      ...(lines ? { lines: lines.map(({ request: _r, ...l }) => l) } : {}),
      auth: auth.info,
      timings,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return errorResult(e, { request: requestPreview, auth: auth?.info, timings, durationMs: Date.now() - started });
  }
}
