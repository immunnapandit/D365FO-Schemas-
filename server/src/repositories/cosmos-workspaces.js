import { randomUUID } from 'node:crypto';
import { cosmosContainer } from '../db/cosmos.js';
import { notFound } from '../http-errors.js';

const workspaces = () => cosmosContainer('workspaces');
const now = () => new Date().toISOString();

const toWorkspace = (d) => ({
  id: d.id,
  name: d.name,
  ownerId: d.ownerId,
  ownerName: d.ownerName ?? undefined,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

async function readDoc(id) {
  if (!id) return null;
  const { resource } = await workspaces().item(id, id).read();
  return resource && !resource.isDeleted ? resource : null;
}

/** ownerId = that user's workspaces; undefined = every workspace (admins). */
export async function listWorkspaces({ ownerId } = {}) {
  const query =
    ownerId === undefined
      ? { query: 'SELECT * FROM c WHERE c.isDeleted = false ORDER BY c.name' }
      : { query: 'SELECT * FROM c WHERE c.isDeleted = false AND c.ownerId = @owner ORDER BY c.name', parameters: [{ name: '@owner', value: ownerId }] };
  const { resources } = await workspaces().items.query(query).fetchAll();
  return resources.map(toWorkspace);
}

export async function getWorkspace(id) {
  const d = await readDoc(id);
  return d ? toWorkspace(d) : null;
}

export async function createWorkspace({ name }, user) {
  const ts = now();
  const { resource } = await workspaces().items.create({
    id: randomUUID(),
    name: name.trim(),
    ownerId: user.id,
    ownerName: user.name ?? null,
    isDeleted: false,
    createdAt: ts,
    updatedAt: ts,
  });
  return toWorkspace(resource);
}

export async function renameWorkspace(id, name) {
  const d = await readDoc(id);
  if (!d) throw notFound('Workspace not found');
  const { resource } = await workspaces().item(id, id).replace({ ...d, name: name.trim(), updatedAt: now() });
  return toWorkspace(resource);
}

/** Hides the workspace; its forms, modules and history stay in the database but nobody can open them. */
export async function deleteWorkspace(id) {
  const d = await readDoc(id);
  if (!d) throw notFound('Workspace not found');
  await workspaces().item(id, id).replace({ ...d, isDeleted: true, updatedAt: now() });
}

/** Moves forms, modules and history that belong to no workspace (made before workspaces existed) into this one. */
export async function claimUnassigned(workspaceId) {
  const counts = {};
  for (const [name, pk] of [['modules', 'id'], ['forms', 'id'], ['executions', 'formId']]) {
    const c = cosmosContainer(name);
    const { resources } = await c.items
      .query('SELECT * FROM c WHERE NOT IS_DEFINED(c.workspaceId) OR IS_NULL(c.workspaceId)')
      .fetchAll();
    for (const doc of resources) {
      // eslint-disable-next-line no-unused-vars
      const { _rid, _self, _etag, _attachments, _ts, ...clean } = doc;
      await c.item(doc.id, doc[pk]).replace({ ...clean, workspaceId });
    }
    counts[name] = resources.length;
  }
  return counts;
}
