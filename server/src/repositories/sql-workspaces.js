import { randomUUID } from 'node:crypto';
import { getDb } from '../db/knex.js';
import { notFound } from '../http-errors.js';

const now = () => new Date().toISOString();

const toWorkspace = (r) => ({
  id: r.id,
  name: r.name,
  ownerId: r.owner_id,
  ownerName: r.owner_name ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** ownerId = that user's workspaces; undefined = every workspace (admins). */
export async function listWorkspaces({ ownerId } = {}) {
  const q = getDb()('workspaces').where({ is_deleted: false }).orderBy('name');
  if (ownerId !== undefined) q.where({ owner_id: ownerId });
  return (await q).map(toWorkspace);
}

export async function getWorkspace(id) {
  if (!id) return null;
  const r = await getDb()('workspaces').where({ id, is_deleted: false }).first();
  return r ? toWorkspace(r) : null;
}

export async function createWorkspace({ name }, user) {
  const ts = now();
  const row = { id: randomUUID(), name: name.trim(), owner_id: user.id, owner_name: user.name ?? null, is_deleted: false, created_at: ts, updated_at: ts };
  await getDb()('workspaces').insert(row);
  return toWorkspace(row);
}

export async function renameWorkspace(id, name) {
  const n = await getDb()('workspaces').where({ id, is_deleted: false }).update({ name: name.trim(), updated_at: now() });
  if (!n) throw notFound('Workspace not found');
  return getWorkspace(id);
}

/** Hides the workspace; its forms, modules and history stay in the database but nobody can open them. */
export async function deleteWorkspace(id) {
  const n = await getDb()('workspaces').where({ id, is_deleted: false }).update({ is_deleted: true, updated_at: now() });
  if (!n) throw notFound('Workspace not found');
}

/** Moves forms, modules and history that belong to no workspace (made before workspaces existed) into this one. */
export async function claimUnassigned(workspaceId) {
  const db = getDb();
  return db.transaction(async (trx) => {
    const counts = {};
    for (const table of ['modules', 'forms', 'executions']) {
      counts[table] = await trx(table).whereNull('workspace_id').update({ workspace_id: workspaceId });
    }
    return counts;
  });
}
