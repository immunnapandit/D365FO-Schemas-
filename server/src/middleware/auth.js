import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../http-errors.js';

/**
 * Who is calling the API?
 *
 *  entra    – the React app signs in with MSAL and sends an Entra ID access token.
 *             We validate signature (JWKS), issuer, audience, expiry and the delegated scope.
 *  easyauth – App Service / Container Apps Authentication signs the user in before the request
 *             reaches us and passes the user in the X-MS-CLIENT-PRINCIPAL header.
 *             Only safe when platform authentication is ON and "require authentication" is set,
 *             because the platform removes this header from outside requests.
 *  none     – local development only. Everyone is an admin.
 *
 * Roles come from Entra ID app roles (e.g. SchemaForms.Admin, SchemaForms.User).
 */

let jwks = null;
const getJwks = (uri) => (jwks ??= createRemoteJWKSet(new URL(uri), { cooldownDuration: 30_000, cacheMaxAge: 3_600_000 }));

const ROLE_CLAIMS = ['roles', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'];

function finishUser(user, a) {
  user.roles = [...new Set(user.roles || [])];
  user.isAdmin = user.roles.includes(a.adminRole);
  user.hasAccess = !a.requireRole || user.isAdmin || user.roles.includes(a.userRole);
  return user;
}

async function fromEntraToken(req, a) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthorized();
  let payload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(a.jwksUri), {
      issuer: [a.issuer, `https://sts.windows.net/${a.tenantId}/`].filter(Boolean),
      audience: a.apiAudience,
      clockTolerance: 60,
    }));
  } catch (e) {
    throw unauthorized(e.code === 'ERR_JWT_EXPIRED' ? 'Your session has expired. Please sign in again.' : 'Invalid access token');
  }
  // must be a user (delegated) token with our scope, not an app-only token
  const requiredScope = a.apiScope.split('/').pop();
  const scopes = String(payload.scp || '').split(' ');
  if (!payload.scp || (requiredScope && !scopes.includes(requiredScope))) {
    throw unauthorized(`Access token is missing the "${requiredScope}" scope`);
  }
  return {
    id: payload.oid || payload.sub,
    name: payload.name || payload.preferred_username || payload.upn || 'Unknown user',
    username: payload.preferred_username || payload.upn || payload.email || '',
    roles: Array.isArray(payload.roles) ? payload.roles : [],
  };
}

function fromEasyAuth(req) {
  const raw = req.headers['x-ms-client-principal'];
  if (!raw) throw unauthorized();
  let principal;
  try {
    principal = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
  } catch {
    throw unauthorized('Invalid client principal');
  }
  const claims = principal.claims || [];
  const get = (...types) => claims.find((c) => types.includes(c.typ))?.val;
  const roleTypes = [principal.role_typ, ...ROLE_CLAIMS].filter(Boolean);
  return {
    id:
      get('http://schemas.microsoft.com/identity/claims/objectidentifier', 'oid') ||
      req.headers['x-ms-client-principal-id'] ||
      'unknown',
    name: get('name') || req.headers['x-ms-client-principal-name'] || 'Unknown user',
    username: get('preferred_username', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn') || '',
    roles: claims.filter((c) => roleTypes.includes(c.typ)).map((c) => c.val),
  };
}

export function authenticate(a = config.auth) {
  return async (req, _res, next) => {
    try {
      let user;
      if (a.mode === 'entra') user = await fromEntraToken(req, a);
      else if (a.mode === 'easyauth') user = fromEasyAuth(req);
      else user = { id: 'local-dev', name: 'Local Developer', username: 'dev@localhost', roles: [a.adminRole] };
      req.user = finishUser(user, a);
      if (!req.user.hasAccess) {
        throw forbidden(`Your account has no access to this app. Ask an admin to assign you the "${a.userRole}" role.`);
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireAdmin(req, _res, next) {
  if (req.user?.isAdmin) return next();
  next(forbidden('Only admins can do this.'));
}

export function canAccessForm(user, form) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (!form.allowedRoles?.length) return true;
  return form.allowedRoles.some((r) => user.roles.includes(r));
}
