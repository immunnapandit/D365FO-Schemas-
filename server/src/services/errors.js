/**
 * Turns whatever an API sent back into one readable shape for the UI:
 *   { message, details[], code }
 *
 * Knows the common formats:
 *  - D365 F&O OData:   { error: { message, innererror: { message, internalexception } } }
 *  - Entra ID token:   { error, error_description }
 *  - ASP.NET problem:  { title, detail, errors }
 *  - Generic:          { message } / { error: "text" } / plain text
 */

export class StageError extends Error {
  constructor(stage, message, extra = {}) {
    super(message);
    this.stage = stage; // 'config' | 'auth' | 'api' | 'network'
    Object.assign(this, extra);
  }
}

function collectInner(inner, out) {
  let node = inner;
  let depth = 0;
  while (node && depth < 6) {
    if (node.message && !out.includes(node.message)) out.push(String(node.message).trim());
    node = node.internalexception || node.innererror;
    depth += 1;
  }
}

const STATUS_TEXT = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  408: 'Request Timeout', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};
const STATUS_HINT = {
  404: 'Check the URL and the path.',
  405: 'Check the method (GET, POST, ...).',
  415: 'The API may expect another body type.',
  502: 'A gateway could not reach the system behind it.',
  503: 'The system may be down or restarting. Try again later.',
  504: 'A gateway waited too long for the system behind it.',
};

/** An HTML error page (gateway, web server) as one readable line: status, the page's title or text, and a hint. */
function htmlText(status, html) {
  const pick = (re) => (html.match(re)?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const text = pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || pick(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const head = `HTTP ${status}${STATUS_TEXT[status] ? ` ${STATUS_TEXT[status]}` : ''}`;
  const rest = text.replace(new RegExp(`^${status}\\b[\\s:-]*`), '').trim(); // "502 Bad Gateway" adds nothing to the status
  const said = rest && rest.toLowerCase() !== (STATUS_TEXT[status] ?? '').toLowerCase() ? `: ${text.slice(0, 300)}` : '';
  return `${head}${said} (the system answered with a web page, not JSON).${STATUS_HINT[status] ? ` ${STATUS_HINT[status]}` : ''}`;
}

export function normalizeApiError(status, body) {
  const details = [];
  let message;
  let code;

  if (body && typeof body === 'object') {
    const err = body.error;
    if (err && typeof err === 'object') {
      code = err.code || undefined;
      message = err.message;
      collectInner(err.innererror, details);
      if (Array.isArray(err.details)) {
        for (const d of err.details) if (d?.message) details.push(d.message);
      }
    } else if (typeof err === 'string') {
      code = err;
      message = body.error_description || body.message || err;
    } else if (body.title || body.detail) {
      message = body.title;
      if (body.detail) details.push(body.detail);
      if (body.errors && typeof body.errors === 'object') {
        for (const [field, msgs] of Object.entries(body.errors)) {
          details.push(`${field}: ${[].concat(msgs).join(', ')}`);
        }
      }
    } else if (body.message || body.Message) {
      message = body.message || body.Message;
      if (body.ExceptionMessage) details.push(body.ExceptionMessage);
    }
  } else if (typeof body === 'string' && body.trim()) {
    message = /^\s*(<!doctype|<html|<\?xml|<)/i.test(body) && /<\/?[a-z][^>]*>/i.test(body) ? htmlText(status, body) : body.trim().slice(0, 1000);
  }

  // F&O often says "An error has occurred." on top and puts the real infolog below.
  if ((!message || /^an error has occurred\.?$/i.test(message)) && details.length) {
    message = details.shift();
  }

  return {
    code,
    message: message || `Request failed with HTTP ${status}`,
    details: details.filter((d) => d && d !== message),
  };
}

/* ---------------- sign-in (token) errors ---------------- */

/** Microsoft Entra ID error codes -> what the admin should do. */
const AADSTS_HINTS = {
  7000215: 'The client secret is wrong. Use the secret value (not the secret ID) from the app registration.',
  7000222: 'The client secret has expired. Create a new secret in the app registration and update the sign-in.',
  700016: 'The client ID was not found in this tenant. Check the client ID and the tenant ID.',
  90002: 'The tenant was not found. Check the tenant ID.',
  900023: 'The tenant ID is not valid. Check the tenant ID.',
  90013: 'The tenant ID is missing in the token URL. Check the tenant ID.',
  500011: 'The scope points to an API that is not known in this tenant. Check the scope, e.g. https://<environment>.operations.dynamics.com/.default.',
  70011: 'The scope is not valid. For client credentials it must end with /.default.',
  1002012: 'The scope is not valid. For client credentials it must end with /.default.',
  900144: 'A required value is missing in the sign-in (client ID, secret, scope or grant type).',
  7000218: 'The client secret is missing. Fill it in on the sign-in.',
  50126: 'The username or password is wrong.',
  50034: 'The user does not exist in this tenant.',
  50076: 'The account needs multi-factor authentication, which this sign-in type cannot do. Use a service account or client credentials.',
  50079: 'The account needs multi-factor authentication, which this sign-in type cannot do. Use a service account or client credentials.',
  65001: 'The app has no consent for this API. An admin must grant consent in Entra ID.',
  700024: 'The client assertion is not valid. Check the app credentials.',
  53003: 'Access was blocked by a Conditional Access policy.',
};

/** Generic OAuth 2.0 error codes (RFC 6749) -> what the admin should do. */
const OAUTH_HINTS = {
  invalid_client: 'The client ID or client secret was rejected.',
  unauthorized_client: 'This app is not allowed to use this sign-in type.',
  invalid_scope: 'The scope is not valid.',
  invalid_grant: 'The username/password or grant was rejected.',
  invalid_request: 'The sign-in request is missing a value or has a wrong value.',
  unsupported_grant_type: 'This sign-in type is not supported by the token URL.',
};

/**
 * Turns a failed token response into a short, clear message plus details for support.
 * Example: "Sign-in failed: The client secret is wrong. …" with details
 * ["Microsoft: AADSTS7000215: Invalid client secret provided.", "Error code: AADSTS7000215", "Trace ID: …"].
 */
export function explainTokenError(status, body) {
  const n = normalizeApiError(status, body);
  const text = typeof body === 'object' && body ? String(body.error_description || n.message || '') : String(n.message || '');
  const aad = text.match(/AADSTS(\d+)/);
  const codes = Array.isArray(body?.error_codes) ? body.error_codes : [];
  const aadCode = aad ? Number(aad[1]) : codes[0];
  const firstSentence = text.split(/\r?\n/)[0].replace(/\s*Trace ID:.*$/i, '').trim();

  let hint = aadCode && AADSTS_HINTS[aadCode];
  if (!hint && n.code && OAUTH_HINTS[n.code]) hint = OAUTH_HINTS[n.code];
  if (!hint && status === 404) hint = 'The token URL was not found (HTTP 404). Check the token URL.';
  if (!hint && status >= 500) hint = `The sign-in server had an error (HTTP ${status}). Try again in a moment.`;

  const details = [];
  if (hint && firstSentence) details.push(`Message from the sign-in server: ${firstSentence}`);
  if (aadCode) details.push(`Error code: AADSTS${aadCode}`);
  else if (n.code) details.push(`Error code: ${n.code}`);
  const trace = text.match(/Trace ID:\s*([\w-]+)/i)?.[1] || body?.trace_id;
  const corr = text.match(/Correlation ID:\s*([\w-]+)/i)?.[1] || body?.correlation_id;
  if (trace) details.push(`Trace ID: ${trace}`);
  if (corr) details.push(`Correlation ID: ${corr}`);
  for (const d of n.details) if (!details.includes(d)) details.push(d);

  return {
    message: `Sign-in failed: ${hint || firstSentence || `HTTP ${status}`}`,
    details,
    code: aadCode ? `AADSTS${aadCode}` : n.code,
  };
}
