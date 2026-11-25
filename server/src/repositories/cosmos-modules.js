import { cosmosContainer } from '../db/cosmos.js';
import { notFound, conflict } from '../http-errors.js';
import { encryptDefinition, restoreMasked, encrypt, decrypt } from '../services/secrets.js';
import { now, slug, sameName, staleConflict, nameTaken, packSpec, unpackSpec, checkStoredSpecSize } from './module-common.js';

const modules = () => cosmosContainer('modules');

function docToModule(d) {
  return {
    id: d.id,
    name: d.name,
    description: d.description ?? undefined,
    workspaceId: d.workspaceId ?? undefined,
    auth: d.auth ?? { type: 'none' },
    variables: d.variables ?? {},
    headers: d.headers ?? {},
    version: Number(d.version),
    spec: d.specUpdatedAt ? { fileName: d.specFileName ?? undefined, updatedAt: d.specUpdatedAt, updatedBy: d.specUpdatedBy } : undefined,
    createdAt: d.createdAt,
    createdBy: d.createdBy,
    updatedAt: d.updatedAt,
    updatedBy: d.updatedBy,
  };
}

async function readDoc(id) {
  const { resource } = await modules().item(id, id).read();
  return resource && !resource.isDeleted ? resource : null;
}

/** Modules of one workspace (all modules when workspaceId is undefined, for maintenance scripts). */
export async function listModules(workspaceId) {
  const inWorkspace =
    workspaceId === undefined ? '' : workspaceId === null ? ' AND (NOT IS_DEFINED(c.workspaceId) OR IS_NULL(c.workspaceId))' : ' AND c.workspaceId = @ws';
  const { resources } = await modules()
    .items.query({
      query:
        'SELECT c.id, c.name, c.description, c.workspaceId, c.auth, c.variables, c.headers, c.version, c.specFileName, c.specUpdatedAt, ' +
        `c.specUpdatedBy, c.createdAt, c.createdBy, c.updatedAt, c.updatedBy FROM c WHERE c.isDeleted = false${inWorkspace} ORDER BY c.name`,
      parameters: workspaceId ? [{ name: '@ws', value: workspaceId }] : [],
    })
    .fetchAll();
  return resources.map(docToModule);
}

export async function getModule(id) {
  const d = await readDoc(id);
  return d ? docToModule(d) : null;
}

/** Module names are unique inside a workspace (forms are linked to their module by name). */
export async function getModuleByName(name, workspaceId) {
  if (!name) return null;
  return (await listModules(workspaceId ?? null)).find((m) => sameName(m.name, name)) ?? null;
}

export async function createModule(mod, user, workspaceId = null) {
  if (await getModuleByName(mod.name, workspaceId)) throw nameTaken(mod.name);
  const secured = encryptDefinition(mod);
  const ts = now();
  const base = slug(mod.name);
  for (let i = 1; i <= 20; i += 1) {
    try {
      const { resource } = await modules().items.create({
        id: i === 1 ? base : `${base}-${i}`,
        name: secured.name.trim(),
        description: secured.description ?? null,
        workspaceId,
        auth: secured.auth,
        variables: secured.variables ?? {},
        headers: secured.headers ?? {},
        version: 1,
        isDeleted: false,
        createdAt: ts,
        createdBy: user?.name ?? null,
        updatedAt: ts,
        updatedBy: user?.name ?? null,
      });
      return docToModule(resource);
    } catch (e) {
      if (e.code !== 409) throw e;
    }
  }
  throw conflict('Could not find a free id for this module name.');
}

export async function updateModule(id, mod, expectedVersion, user) {
  const current = await readDoc(id);
  if (!current) throw notFound('Module not found');
  if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current.version)) throw staleConflict(current);
  if (!sameName(mod.name, current.name) && (await getModuleByName(mod.name, current.workspaceId ?? null))) throw nameTaken(mod.name);
  const merged = encryptDefinition({
    ...mod,
    auth: restoreMasked(mod.auth, current.auth),
    variables: restoreMasked(mod.variables ?? {}, current.variables),
    headers: restoreMasked(mod.headers ?? {}, current.headers ?? {}),
  });
  const next = {
    ...current,
    name: merged.name.trim(),
    description: merged.description ?? null,
    auth: merged.auth,
    variables: merged.variables ?? {},
    headers: merged.headers ?? {},
    version: Number(current.version) + 1,
    updatedAt: now(),
    updatedBy: user?.name ?? null,
  };
  try {
    const { resource } = await modules()
      .item(id, id)
      .replace(next, { accessCondition: { type: 'IfMatch', condition: current._etag } });
    return docToModule(resource);
  } catch (e) {
    if (e.code === 412) throw staleConflict(current);
    throw e;
  }
}

export async function deleteModule(id, user) {
  const current = await readDoc(id);
  if (!current) throw notFound('Module not found');
  await modules()
    .item(id, id)
    .replace({ ...current, isDeleted: true, updatedAt: now(), updatedBy: user?.name ?? null });
}

/** The OpenAPI file of the module (stored encrypted: exports can contain example secrets). */
export async function getModuleSpec(id) {
  const d = await readDoc(id);
  if (!d?.spec) return null;
  return { content: unpackSpec(decrypt(d.spec)), fileName: d.specFileName ?? undefined, updatedAt: d.specUpdatedAt, updatedBy: d.specUpdatedBy };
}

export async function setModuleSpec(id, { content, fileName }, user) {
  const current = await readDoc(id);
  if (!current) throw notFound('Module not found');
  await modules()
    .item(id, id)
    .replace({ ...current, spec: checkStoredSpecSize(encrypt(packSpec(content))), specFileName: fileName ?? null, specUpdatedAt: now(), specUpdatedBy: user?.name ?? null });
}
