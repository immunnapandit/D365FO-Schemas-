import { cosmosContainer } from '../db/cosmos.js';
import { notFound, conflict } from '../http-errors.js';
import { encryptDefinition, restoreMasked } from '../services/secrets.js';
import { now, slug, sameName, staleConflict, nameTaken } from './module-common.js';

const modules = () => cosmosContainer('modules');

function docToModule(d) {
  return {
    id: d.id,
    name: d.name,
    description: d.description ?? undefined,
    auth: d.auth ?? { type: 'none' },
    variables: d.variables ?? {},
    headers: d.headers ?? {},
    version: Number(d.version),
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

export async function listModules() {
  const { resources } = await modules()
    .items.query('SELECT * FROM c WHERE c.isDeleted = false ORDER BY c.name')
    .fetchAll();
  return resources.map(docToModule);
}

export async function getModule(id) {
  const d = await readDoc(id);
  return d ? docToModule(d) : null;
}

export async function getModuleByName(name) {
  if (!name) return null;
  return (await listModules()).find((m) => sameName(m.name, name)) ?? null;
}

export async function createModule(mod, user) {
  if (await getModuleByName(mod.name)) throw nameTaken(mod.name);
  const secured = encryptDefinition(mod);
  const ts = now();
  const base = slug(mod.name);
  for (let i = 1; i <= 20; i += 1) {
    try {
      const { resource } = await modules().items.create({
        id: i === 1 ? base : `${base}-${i}`,
        name: secured.name.trim(),
        description: secured.description ?? null,
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
  if (!sameName(mod.name, current.name) && (await getModuleByName(mod.name))) throw nameTaken(mod.name);
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
