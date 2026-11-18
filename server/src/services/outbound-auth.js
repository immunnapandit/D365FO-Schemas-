import { createHash } from 'node:crypto';
import { resolveDeep } from './template.js';
import { httpRequest } from './http.js';
import { StageError, explainTokenError } from './errors.js';
import { AUTH_TYPES } from './definition-schema.js';

/**
 * Supported auth.type values:
 *
 *  none
 *  basic                      { username, password }
 *  bearer_static              { token }
 *  api_key                    { headerName, value }
 *  oauth2_password            { tokenUrl, username, password, clientId?, clientSecret?, scope? }
 *  oauth2_client_credentials  { tokenUrl, clientId, clientSecret, scope?, resource?, extraParams? }
 *                             -> Microsoft Entra ID / D365 F&O
 *  token_endpoint             { url, method?, bodyType? ('json'|'form'), headers?, body,
 *                               tokenPath?, expiresInPath?, headerName?, prefix? }
 *                             -> any "login" API that returns a token in JSON
 */
export { AUTH_TYPES };

const cache = new Map(); // key -> { token, expiresAt }
const inFlight = new Map(); // key -> Promise (many users submitting at once share one token request)
const SAFETY_MS = 60_000;

function cacheKey(cfg) {
  return createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

const FIELD_LABELS = {
  tokenUrl: 'token URL',
  clientId: 'client ID',
  clientSecret: 'client secret',
  scope: 'scope',
  username: 'username',
  password: 'password',
  token: 'token',
  headerName: 'header name',
  value: 'key value',
  url: 'login URL',
};

function requireFields(cfg, fields, type) {
  const missing = fields.filter((f) => cfg[f] === undefined || cfg[f] === '');
  if (missing.length) {
    throw new StageError(
      'config',
      `The sign-in is not complete: ${missing.map((f) => FIELD_LABELS[f] ?? f).join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty. Fill ${missing.length === 1 ? 'it' : 'them'} in on the module's sign-in.`,
      { details: [`Sign-in type: ${type}`] },
    );
  }
}

async function fetchToken(cfg, { force }) {
  const key = cacheKey(cfg);
  const hit = cache.get(key);
  if (!force && hit && hit.expiresAt > Date.now()) return { ...hit, cached: true };
  if (inFlight.has(key)) return inFlight.get(key);
  const p = requestToken(cfg, key).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function requestToken(cfg, key) {
  let request;
  let tokenPath = 'access_token';
  let expiresInPath = 'expires_in';

  if (cfg.type === 'oauth2_client_credentials') {
    requireFields(cfg, ['tokenUrl', 'clientId', 'clientSecret'], cfg.type);
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
    if (cfg.scope) form.set('scope', cfg.scope);
    if (cfg.resource) form.set('resource', cfg.resource); // old v1 endpoint
    for (const [k, v] of Object.entries(cfg.extraParams || {})) form.set(k, String(v));
    request = {
      url: cfg.tokenUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    };
  } else if (cfg.type === 'oauth2_password') {
    // resource owner password grant: a service account signs in with username + password
    requireFields(cfg, ['tokenUrl', 'username', 'password'], cfg.type);
    const form = new URLSearchParams({ grant_type: 'password', username: cfg.username, password: cfg.password });
    if (cfg.clientId) form.set('client_id', cfg.clientId);
    if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
    if (cfg.scope) form.set('scope', cfg.scope);
    if (cfg.resource) form.set('resource', cfg.resource);
    for (const [k, v] of Object.entries(cfg.extraParams || {})) form.set(k, String(v));
    request = {
      url: cfg.tokenUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    };
  } else {
    // token_endpoint
    requireFields(cfg, ['url'], cfg.type);
    const bodyType = cfg.bodyType || 'json';
    const headers = { Accept: 'application/json', ...cfg.headers };
    let body;
    if (cfg.body !== undefined) {
      if (bodyType === 'form') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(cfg.body).toString();
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(cfg.body);
      }
    }
    request = { url: cfg.url, method: cfg.method || 'POST', headers, body };
    tokenPath = cfg.tokenPath || 'access_token';
    expiresInPath = cfg.expiresInPath || 'expires_in';
  }

  // token endpoints are safe to retry (no side effects)
  const res = await httpRequest('auth', request, { retries: 2 });
  if (!res.ok) {
    const n = explainTokenError(res.status, res.body);
    throw new StageError('auth', n.message, {
      status: res.status,
      details: n.details,
      code: n.code,
      raw: res.body,
      durationMs: res.durationMs,
    });
  }
  const token = res.body && typeof res.body === 'object' ? getPath(res.body, tokenPath) : undefined;
  if (!token) {
    throw new StageError('auth', `Sign-in failed: the token response has no "${tokenPath}". Check the token URL and the token path.`, {
      status: res.status,
      raw: res.body,
    });
  }
  const expiresIn = Number(getPath(res.body, expiresInPath)) || 300;
  const entry = { token, expiresAt: Date.now() + expiresIn * 1000 - SAFETY_MS, durationMs: res.durationMs };
  cache.set(key, entry);
  return { ...entry, cached: false };
}

/**
 * Returns the headers to add to the real API call.
 * @returns {{ headers: Record<string,string>, info: object }}
 */
export async function getAuthHeaders(rawAuth, ctx, { force = false } = {}) {
  const auth = rawAuth || { type: 'none' };
  if (!AUTH_TYPES.includes(auth.type)) {
    throw new StageError('config', `Unknown auth.type "${auth.type}". Use one of: ${AUTH_TYPES.join(', ')}`);
  }
  if (auth.type === 'module') {
    throw new StageError('config', "This form uses its module's sign-in, but the module has none. Open the module and set up its sign-in.");
  }
  let cfg;
  try {
    cfg = resolveDeep(auth, ctx);
  } catch (e) {
    throw new StageError('config', e.message);
  }

  switch (cfg.type) {
    case 'none':
      return { headers: {}, info: { type: 'none' } };
    case 'basic': {
      requireFields(cfg, ['username', 'password'], cfg.type);
      const b64 = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
      return { headers: { Authorization: `Basic ${b64}` }, info: { type: 'basic' } };
    }
    case 'bearer_static':
      requireFields(cfg, ['token'], cfg.type);
      return { headers: { Authorization: `Bearer ${cfg.token}` }, info: { type: 'bearer_static' } };
    case 'api_key':
      requireFields(cfg, ['headerName', 'value'], cfg.type);
      return { headers: { [cfg.headerName]: cfg.value }, info: { type: 'api_key' } };
    default: {
      const t = await fetchToken(cfg, { force });
      const headerName = cfg.headerName || 'Authorization';
      const prefix = cfg.prefix ?? 'Bearer ';
      return {
        headers: { [headerName]: `${prefix}${t.token}` },
        token: t.token,
        info: {
          type: cfg.type,
          cached: t.cached,
          expiresInSec: Math.max(0, Math.round((t.expiresAt + SAFETY_MS - Date.now()) / 1000)),
          tokenDurationMs: t.cached ? 0 : t.durationMs,
        },
      };
    }
  }
}

export function clearTokenCache() {
  cache.clear();
}
