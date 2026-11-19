import { gzipSync, gunzipSync } from 'node:zlib';
import { badRequest, conflict } from '../http-errors.js';

export const now = () => new Date().toISOString();

export function slug(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'module'
  );
}

export const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export const staleConflict = (current) =>
  conflict(
    `This module was changed by ${current.updatedBy || 'someone else'} at ${String(current.updatedAt).slice(0, 16).replace('T', ' ')} UTC. Reload it and apply your change again.`,
  );

export const nameTaken = (name) => conflict(`A module called "${name}" already exists.`);

/*
 * The imported file is kept compressed (gzip) and then encrypted. An OpenAPI or Postman export is mostly
 * repeated text and shrinks about ten times, so large files fit in one database record (Cosmos DB: 2 MB).
 * Files saved before compression have no prefix and are read as they are.
 */
const PACKED = 'gz1:';
/** Largest stored (compressed, encrypted) file: leaves room for the rest of the module record. */
export const MAX_STORED_SPEC = 1_600_000;

export function packSpec(text) {
  return PACKED + gzipSync(Buffer.from(String(text), 'utf8'), { level: 9 }).toString('base64');
}

export function unpackSpec(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PACKED)) return stored;
  return gunzipSync(Buffer.from(stored.slice(PACKED.length), 'base64')).toString('utf8');
}

export function checkStoredSpecSize(stored) {
  if (stored.length > MAX_STORED_SPEC) {
    throw badRequest('The file is too large to keep with the module, even compressed. Import a smaller part of it (fewer requests or tags).');
  }
  return stored;
}
