import { getDb } from '../db/knex.js';
import { notFound } from '../http-errors.js';
import { encryptDefinition, restoreMasked } from '../services/secrets.js';
import { now, slug, sameName, staleConflict, nameTaken } from './module-common.js';

const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

function rowToModule(r) {
  const d = parse(r.definition);
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    auth: d.auth ?? { type: 'none' },
    variables: d.variables ?? {},
    headers: d.headers ?? {},
    version: Number(r.version),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

const toColumns = (m) => ({
  name: m.name.trim(),
  description: m.description ?? null,
  definition: JSON.stringify({ auth: m.auth, variables: m.variables ?? {}, headers: m.headers ?? {} }),
});

export async function listModules() {
  const rows = await getDb()('modules').where({ is_deleted: false }).orderBy('name');
  return rows.map(rowToModule);
}

export async function getModule(id) {
  const row = await getDb()('modules').where({ id, is_deleted: false }).first();
  return row ? rowToModule(row) : null;
}

export async function getModuleByName(name) {
  if (!name) return null;
  return (await listModules()).find((m) => sameName(m.name, name)) ?? null;
}

export async function createModule(mod, user) {
  if (await getModuleByName(mod.name)) throw nameTaken(mod.name);
  const db = getDb();
  const base = slug(mod.name);
  let id = base;
  for (let i = 2; await db('modules').where({ id }).first(); i += 1) id = `${base}-${i}`;
  const ts = now();
  await db('modules').insert({
    id,
    ...toColumns(encryptDefinition(mod)),
    version: 1,
    is_deleted: false,
    created_at: ts,
    created_by: user?.name ?? null,
    updated_at: ts,
    updated_by: user?.name ?? null,
  });
  return getModule(id);
}

export async function updateModule(id, mod, expectedVersion, user) {
  const db = getDb();
  return db.transaction(async (trx) => {
    const row = await trx('modules').where({ id, is_deleted: false }).first();
    if (!row) throw notFound('Module not found');
    const current = rowToModule(row);
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) throw staleConflict(current);
    if (!sameName(mod.name, current.name)) {
      const other = (await trx('modules').where({ is_deleted: false })).map(rowToModule).find((m) => sameName(m.name, mod.name));
      if (other) throw nameTaken(mod.name);
    }
    const merged = {
      ...mod,
      auth: restoreMasked(mod.auth, current.auth),
      variables: restoreMasked(mod.variables ?? {}, current.variables),
      headers: restoreMasked(mod.headers ?? {}, current.headers),
    };
    const n = await trx('modules')
      .where({ id, version: current.version })
      .update({ ...toColumns(encryptDefinition(merged)), version: current.version + 1, updated_at: now(), updated_by: user?.name ?? null });
    if (!n) throw staleConflict(current);
    return rowToModule(await trx('modules').where({ id }).first());
  });
}

export async function deleteModule(id, user) {
  const n = await getDb()('modules')
    .where({ id, is_deleted: false })
    .update({ is_deleted: true, updated_at: now(), updated_by: user?.name ?? null });
  if (!n) throw notFound('Module not found');
}
