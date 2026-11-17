import { conflict } from '../http-errors.js';

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
