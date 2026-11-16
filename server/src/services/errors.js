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
    message = body.trim().slice(0, 1000);
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
