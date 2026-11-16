import { config } from '../config.js';
import { StageError } from './errors.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Only hosts listed in ALLOWED_HOSTS may be called (protects against SSRF). "*.domain.com" allowed. */
export function assertHostAllowed(url, stage, allowed = config.security.allowedHosts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new StageError('config', `Invalid URL: "${url}"`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new StageError('config', `Only http/https URLs are allowed: "${url}"`);
  }
  if (parsed.username || parsed.password) {
    throw new StageError('config', 'Credentials inside the URL are not allowed. Use the auth section.');
  }
  if (!allowed.length) return parsed;
  const host = parsed.hostname.toLowerCase();
  const ok = allowed.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p));
  if (!ok) throw new StageError(stage, `Host "${host}" is not in ALLOWED_HOSTS on the server.`);
  return parsed;
}

async function readBody(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryDelay(res, attempt) {
  const ra = res?.headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 5000);
  }
  return Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250);
}

/**
 * fetch with timeout, size limit, no automatic redirects, optional retries.
 * Returns { status, ok, headers, body (JSON or text), durationMs, attempts }.
 */
export async function httpRequest(stage, { url, method = 'GET', headers = {}, body }, opts = {}) {
  assertHostAllowed(url, stage);
  const timeoutMs = opts.timeoutMs || config.requestTimeoutMs;
  const retries = opts.retries ?? 0;
  const started = Date.now();
  let attempt = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
      text = await readBody(res);
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(retryDelay(null, attempt++));
        continue;
      }
      const reason =
        e.name === 'AbortError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : e.cause?.code || e.cause?.message || e.message;
      throw new StageError('network', `Could not reach ${new URL(url).host}: ${reason}`, {
        durationMs: Date.now() - started,
      });
    }
    clearTimeout(timer);

    if (RETRY_STATUS.has(res.status) && attempt < retries) {
      await sleep(retryDelay(res, attempt++));
      continue;
    }

    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (res.status >= 300 && res.status < 400) {
      parsed = `The server redirected to ${res.headers.get('location') || 'another URL'}. Redirects are not followed; use the final URL in the schema.`;
    }
    return {
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries()),
      body: parsed,
      durationMs: Date.now() - started,
      attempts: attempt + 1,
    };
  }
}
