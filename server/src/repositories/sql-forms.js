import { randomUUID, randomBytes } from 'node:crypto';
import { getDb } from '../db/knex.js';
import { conflict, notFound } from '../http-errors.js';
import { encryptDefinition, restoreMasked } from '../services/secrets.js';

const now = () => new Date().toISOString();
const parse = (s, fallback = null) => {
  if (s === null || s === undefined || s === '') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
const DEFINITION_KEYS = ['auth', 'api', 'source', 'formSchema', 'uiSchema'];

function rowToForm(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    icon: row.icon ?? undefined,
    category: row.category ?? undefined,
    group: row.form_group ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    ...parse(row.definition, {}),
    allowedRoles: parse(row.allowed_roles, undefined) ?? undefined,
    version: Number(row.version),
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function toColumns(def) {
  const definition = Object.fromEntries(DEFINITION_KEYS.filter((k) => def[k] !== undefined).map((k) => [k, def[k]]));
  return {
    name: def.name.trim(),
    description: def.description ?? null,
    icon: def.icon ?? null,
    category: def.category?.trim() || null,
    form_group: def.group?.trim() || null,
    definition: JSON.stringify(definition),
    allowed_roles: def.allowedRoles?.length ? JSON.stringify(def.allowedRoles) : null,
  };
}

function slug(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'form'
  );
}

async function addVersion(trx, form, changeType, user) {
  await trx('form_versions').insert({
    id: randomUUID(),
    form_id: form.id,
    version: form.version,
    change_type: changeType,
    snapshot: JSON.stringify(form),
    changed_at: form.updatedAt,
    changed_by: user?.name ?? null,
  });
}

/** Forms of one workspace (all forms when workspaceId is undefined, for maintenance scripts). */
export async function listForms(workspaceId) {
  const q = getDb()('forms')
    .select('id', 'name', 'description', 'icon', 'category', 'allowed_roles', 'version', 'updated_at', 'updated_by', 'workspace_id', 'form_group')
    .where({ is_deleted: false })
    .orderBy('name');
  if (workspaceId !== undefined) q.where({ workspace_id: workspaceId });
  const rows = await q;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    icon: r.icon ?? undefined,
    category: r.category ?? undefined,
    group: r.form_group ?? undefined,
    workspaceId: r.workspace_id ?? undefined,
    allowedRoles: parse(r.allowed_roles, undefined) ?? undefined,
    version: Number(r.version),
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}

/** Returns the stored form (secrets still encrypted) or null. */
export async function getForm(id, trx = getDb()) {
  const row = await trx('forms').where({ id, is_deleted: false }).first();
  return row ? rowToForm(row) : null;
}

export async function countForms() {
  const r = await getDb()('forms').count({ n: '*' }).first();
  return Number(r.n);
}

export async function createForm(def, user, workspaceId = null) {
  return getDb().transaction(async (trx) => {
    let id = slug(def.name);
    if (await trx('forms').where({ id }).first()) id = `${id.slice(0, 43)}-${randomBytes(2).toString('hex')}`;
    const ts = now();
    const secured = encryptDefinition(def);
    await trx('forms').insert({
      id,
      ...toColumns(secured),
      workspace_id: workspaceId,
      version: 1,
      is_deleted: false,
      created_at: ts,
      created_by: user?.name ?? null,
      updated_at: ts,
      updated_by: user?.name ?? null,
    });
    const form = await getForm(id, trx);
    await addVersion(trx, form, 'create', user);
    return form;
  });
}

/**
 * Optimistic concurrency: the caller sends the version it loaded.
 * If someone else saved in between, we refuse instead of overwriting their change.
 */
export async function updateForm(id, def, expectedVersion, user, changeType = 'update') {
  return getDb().transaction(async (trx) => {
    const current = await getForm(id, trx);
    if (!current) throw notFound('Form not found');
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) {
      throw conflict(
        `This form was changed by ${current.updatedBy || 'someone else'} at ${current.updatedAt.slice(0, 16).replace('T', ' ')} UTC. Load the latest version and apply your change again.`,
      );
    }
    const merged = { ...def, auth: restoreMasked(def.auth, current.auth), api: restoreMasked(def.api, current.api) };
    const secured = encryptDefinition(merged);
    const ts = now();
    const updated = await trx('forms')
      .where({ id, version: current.version, is_deleted: false })
      .update({ ...toColumns(secured), version: current.version + 1, updated_at: ts, updated_by: user?.name ?? null });
    if (!updated) throw conflict('This form was changed at the same time by someone else. Reload and try again.');
    const form = await getForm(id, trx);
    await addVersion(trx, form, changeType, user);
    return form;
  });
}

export async function deleteForm(id, user) {
  return getDb().transaction(async (trx) => {
    const current = await getForm(id, trx);
    if (!current) throw notFound('Form not found');
    const ts = now();
    await trx('forms')
      .where({ id })
      .update({ is_deleted: true, version: current.version + 1, updated_at: ts, updated_by: user?.name ?? null });
    await addVersion(trx, { ...current, version: current.version + 1, updatedAt: ts }, 'delete', user);
  });
}

export async function listVersions(formId) {
  const rows = await getDb()('form_versions')
    .select('id', 'version', 'change_type', 'changed_at', 'changed_by')
    .where({ form_id: formId })
    .orderBy('version', 'desc')
    .limit(100);
  return rows.map((r) => ({
    id: r.id,
    version: Number(r.version),
    changeType: r.change_type,
    changedAt: r.changed_at,
    changedBy: r.changed_by,
  }));
}

/** Returns the stored snapshot of a version (secrets encrypted). */
export async function getVersion(formId, versionId) {
  const row = await getDb()('form_versions').where({ form_id: formId, id: versionId }).first();
  return row ? { version: Number(row.version), snapshot: parse(row.snapshot, {}) } : null;
}
