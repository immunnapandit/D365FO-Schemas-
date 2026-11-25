import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { resolveDeep, resolveString } from './template.js';
import { getAuthHeaders } from './outbound-auth.js';
import { httpRequest } from './http.js';
import { StageError, normalizeApiError } from './errors.js';
import { resolveKvRefs } from './keyvault.js';

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

function buildRequest(api, ctx) {
  const method = (api.method || 'POST').toUpperCase();
  try {
    const pctx = previewContext(ctx);
    const url = new URL(resolveString(api.url, ctx));
    for (const [k, v] of Object.entries(resolveDeep(api.query || {}, ctx))) url.searchParams.set(k, String(v));
    const headers = { Accept: 'application/json', ...resolveDeep(ctx.moduleHeaders || {}, ctx), ...resolveDeep(api.headers || {}, ctx) };
    let body;
    const previewUrl = new URL(resolveString(api.url, pctx));
    for (const [k, v] of Object.entries(resolveDeep(api.query || {}, pctx))) previewUrl.searchParams.set(k, String(v));
    let preview = { method, url: previewUrl.toString() };
    if (!BODYLESS.has(method)) {
      const payload = api.bodyTemplate !== undefined ? resolveDeep(api.bodyTemplate, ctx) : ctx.form;
      if ((api.bodyType || 'json') === 'form') {
        headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
        body = new URLSearchParams(payload).toString();
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
const DYNAMIC = {
  guid: () => randomUUID(),
  randomUUID: () => randomUUID(),
  timestamp: () => String(Math.floor(Date.now() / 1000)),
  isoTimestamp: () => new Date().toISOString(),
  randomInt: () => String(Math.floor(Math.random() * 1001)),
};
const DYNAMIC_RE = /\{\{\s*\$(guid|randomUUID|timestamp|isoTimestamp|randomInt)\s*\}\}/g;

export function resolveDynamicValues(v) {
  if (typeof v === 'string') return v.includes('{{') ? v.replace(DYNAMIC_RE, (_, name) => DYNAMIC[name]()) : v;
  if (Array.isArray(v)) return v.map(resolveDynamicValues);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveDynamicValues(x)]));
  return v;
}

/** form and mod (its module, may be null) = stored definitions with secrets already decrypted */
export async function execute(form, rawFormData, mod = null) {
  const started = Date.now();
  const timings = {};
  let requestPreview;
  let auth; // kept outside try so a failure after sign-in still reports that sign-in worked

  try {
    if (!form.api?.url) throw new StageError('config', 'Schema has no api.url');
    let fd = clean(validateForm(form, rawFormData)) ?? {};
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
    let ctx = { env: process.env, kv, vars, form: fd, token: auth.token, moduleHeaders: mod?.headers };
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

    let message = `Success (HTTP ${res.status})`;
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
      auth: auth.info,
      timings,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return errorResult(e, { request: requestPreview, auth: auth?.info, timings, durationMs: Date.now() - started });
  }
}
