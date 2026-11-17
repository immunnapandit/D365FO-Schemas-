import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Secrets typed directly into a schema (client secret, password, API key…) are:
 *  - encrypted with AES-256-GCM before they are written to the database
 *  - shown to the browser as MASK
 *  - kept unchanged when the browser sends MASK back on save
 * Placeholders such as {{env:NAME}} or {{kv:secret-name}} are not secrets themselves and are shown as-is.
 */

export const MASK = '••••••••';
const PREFIX = 'enc:v1:';
const SECRET_KEY = /secret|password|passwd|^token$|^value$|api[-_]?key|subscription[-_]?key|^authorization$/i;
const ONLY_PLACEHOLDERS = /^(\s*\{\{\s*(env|kv):[^}]+\}\}\s*)+$/;

let key = null;
function getKey() {
  if (key) return key;
  key = config.security.encryptionKey
    ? Buffer.from(config.security.encryptionKey, 'base64')
    : createHash('sha256').update('schema-forms-development-key-do-not-use-in-production').digest();
  return key;
}
// Key rotation: old keys stay readable until `npm run reencrypt` has re-saved everything with the new key.
const oldKeys = () => config.security.previousEncryptionKeys.map((k) => Buffer.from(k, 'base64'));

export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decryptWith(k, raw) {
  const decipher = createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  let lastError;
  for (const k of [getKey(), ...oldKeys()]) {
    try {
      return decryptWith(k, raw);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/** Re-encrypt every secret with the current key (used after a key rotation). */
export const reencryptDefinition = (def) => mapDefinition(def, (v) => (v.startsWith(PREFIX) ? encrypt(decrypt(v)) : v));

const isSecretLiteral = (k, v) => SECRET_KEY.test(k) && typeof v === 'string' && v !== '' && !ONLY_PLACEHOLDERS.test(v);

function mapSecrets(value, fn, key = '') {
  if (Array.isArray(value)) return value.map((v) => mapSecrets(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapSecrets(v, fn, k)]));
  }
  return isSecretLiteral(key, value) ? fn(value) : value;
}

/** auth + api (forms) and auth + variables + headers (modules) are the only places secrets live */
const SECRET_SECTIONS = ['auth', 'api', 'variables', 'headers'];

function mapDefinition(def, fn) {
  const out = { ...def };
  for (const s of SECRET_SECTIONS) if (out[s]) out[s] = mapSecrets(out[s], fn);
  return out;
}

export const encryptDefinition = (def) => mapDefinition(def, (v) => (v.startsWith(PREFIX) || v === MASK ? v : encrypt(v)));
export const decryptDefinition = (def) => mapDefinition(def, (v) => decrypt(v));
export const maskDefinition = (def) => mapDefinition(def, () => MASK);

/** Wherever the client sent MASK back, keep the stored (encrypted) value. */
export function restoreMasked(next, stored) {
  if (next === MASK) return stored;
  if (Array.isArray(next)) return next.map((v, i) => restoreMasked(v, stored?.[i]));
  if (next && typeof next === 'object') {
    return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, restoreMasked(v, stored?.[k])]));
  }
  return next;
}

export function containsMask(value) {
  return JSON.stringify(value ?? null).includes(MASK);
}
