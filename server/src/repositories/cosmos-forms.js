import { randomUUID, randomBytes } from 'node:crypto';
import { cosmosContainer } from '../db/cosmos.js';
import { conflict, notFound } from '../http-errors.js';
import { encryptDefinition, restoreMasked, encrypt, decrypt } from '../services/secrets.js';
import { logger } from '../logger.js';

/**
 * Forms and their versions in Azure Cosmos DB.
 * Same functions and return shapes as sql-forms.js.
 *
 * The definition (auth, api, formSchema, uiSchema) is stored as a JSON string so that
 * keys inside user-written JSON Schemas ($ref, ui:order, …) never clash with Cosmos rules
 * and are not indexed needlessly.
 */

const forms = () => cosmosContainer('forms');
const versions = () => cosmosContainer('formVersions');

const now = () => new Date().toISOString();
const parse = (s, fallback) => {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
const DEFINITION_KEYS = ['auth', 'api', 'source', 'formSchema', 'uiSchema'];

function docToForm(doc) {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description ?? undefined,
    icon: doc.icon ?? undefined,
    category: doc.category ?? undefined,
    group: doc.group ?? undefined,
    workspaceId: doc.workspaceId ?? undefined,
    ...parse(doc.definition, {}),
    allowedRoles: doc.allowedRoles?.length ? doc.allowedRoles : undefined,
    version: Number(doc.version),
    createdAt: doc.createdAt,
    createdBy: doc.createdBy,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
  };
}

function toFields(def) {
  const definition = Object.fromEntries(DEFINITION_KEYS.filter((k) => def[k] !== undefined).map((k) => [k, def[k]]));
  return {
    name: def.name.trim(),
    description: def.description ?? null,
    icon: def.icon ?? null,
    category: def.category?.trim() || null,
    group: def.group?.trim() || null,
    definition: JSON.stringify(definition),
    allowedRoles: def.allowedRoles?.length ? def.allowedRoles : null,
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

/** Reads the raw document (with _etag) or null. Deleted forms count as missing. */
async function readDoc(id) {
  const { resource } = await forms().item(id, id).read();
  return resource && !resource.isDeleted ? resource : null;
}

async function addVersion(form, changeType, user) {
  // Cosmos has no transactions across containers. If this write fails the form is still saved;
  // we log it instead of failing the user's save.
  try {
    await versions().items.create({
      id: randomUUID(),
      formId: form.id,
      version: form.version,
      changeType,
      snapshot: JSON.stringify(form),
      changedAt: form.updatedAt,
      changedBy: user?.name ?? null,
    });
  } catch (e) {
    logger.error({ err: e, formId: form.id, version: form.version }, 'could not save form version');
  }
}

/** Forms of one workspace (all forms when workspaceId is undefined, for maintenance scripts). */
export async function listForms(workspaceId) {
  const inWorkspace =
    workspaceId === undefined ? '' : workspaceId === null ? ' AND (NOT IS_DEFINED(c.workspaceId) OR IS_NULL(c.workspaceId))' : ' AND c.workspaceId = @ws';
  const { resources } = await forms()
    .items.query({
      query:
        'SELECT c.id, c.name, c.description, c.icon, c.category, c.allowedRoles, c.version, c.updatedAt, c.updatedBy, c.workspaceId, c["group"] ' +
        `FROM c WHERE c.isDeleted = false${inWorkspace} ORDER BY c.name`,
      parameters: workspaceId ? [{ name: '@ws', value: workspaceId }] : [],
    })
    .fetchAll();
  return resources.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    icon: r.icon ?? undefined,
    category: r.category ?? undefined,
    group: r.group ?? undefined,
    workspaceId: r.workspaceId ?? undefined,
    allowedRoles: r.allowedRoles?.length ? r.allowedRoles : undefined,
    version: Number(r.version),
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  }));
}

export async function getForm(id) {
  const doc = await readDoc(id);
  return doc ? docToForm(doc) : null;
}

export async function countForms() {
  const { resources } = await forms().items.query('SELECT VALUE COUNT(1) FROM c').fetchAll();
  return Number(resources[0] ?? 0);
}

export async function createForm(def, user, workspaceId = null) {
  const ts = now();
  const base = slug(def.name);
  const secured = encryptDefinition(def);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = attempt === 0 ? base : `${base.slice(0, 43)}-${randomBytes(2).toString('hex')}`;
    try {
      const { resource } = await forms().items.create({
        id,
        ...toFields(secured),
        workspaceId,
        version: 1,
        isDeleted: false,
        createdAt: ts,
        createdBy: user?.name ?? null,
        updatedAt: ts,
        updatedBy: user?.name ?? null,
      });
      const form = docToForm(resource);
      await addVersion(form, 'create', user);
      return form;
    } catch (e) {
      if (e.code !== 409) throw e; // id already used (also by a deleted form) -> try another
    }
  }
  throw conflict('Could not find a free id for this form name. Choose a different name.');
}

/**
 * Optimistic concurrency: the caller sends the version it loaded, and the replace only succeeds
 * if the document is still the one we read (_etag). Nobody's change is silently overwritten.
 */
export async function updateForm(id, def, expectedVersion, user, changeType = 'update') {
  const current = await readDoc(id);
  if (!current) throw notFound('Form not found');
  if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current.version)) {
    throw conflict(
      `This form was changed by ${current.updatedBy || 'someone else'} at ${current.updatedAt.slice(0, 16).replace('T', ' ')} UTC. Load the latest version and apply your change again.`,
    );
  }
  const stored = docToForm(current);
  const merged = { ...def, auth: restoreMasked(def.auth, stored.auth), api: restoreMasked(def.api, stored.api) };
  const next = {
    ...current,
    ...toFields(encryptDefinition(merged)),
    version: Number(current.version) + 1,
    updatedAt: now(),
    updatedBy: user?.name ?? null,
  };
  let resource;
  try {
    ({ resource } = await forms()
      .item(id, id)
      .replace(next, { accessCondition: { type: 'IfMatch', condition: current._etag } }));
  } catch (e) {
    if (e.code === 412) throw conflict('This form was changed at the same time by someone else. Reload and try again.');
    throw e;
  }
  const form = docToForm(resource);
  await addVersion(form, changeType, user);
  return form;
}

export async function deleteForm(id, user) {
  const current = await readDoc(id);
  if (!current) throw notFound('Form not found');
  const next = { ...current, isDeleted: true, version: Number(current.version) + 1, updatedAt: now(), updatedBy: user?.name ?? null };
  try {
    await forms().item(id, id).replace(next, { accessCondition: { type: 'IfMatch', condition: current._etag } });
  } catch (e) {
    if (e.code === 412) throw conflict('This form was changed at the same time by someone else. Reload and try again.');
    throw e;
  }
  await addVersion(docToForm(next), 'delete', user);
}

export async function listVersions(formId) {
  const { resources } = await versions()
    .items.query(
      {
        query:
          'SELECT TOP 100 c.id, c.version, c.changeType, c.changedAt, c.changedBy FROM c WHERE c.formId = @formId ORDER BY c.version DESC',
        parameters: [{ name: '@formId', value: formId }],
      },
      { partitionKey: formId },
    )
    .fetchAll();
  return resources.map((r) => ({
    id: r.id,
    version: Number(r.version),
    changeType: r.changeType,
    changedAt: r.changedAt,
    changedBy: r.changedBy,
  }));
}

export async function getVersion(formId, versionId) {
  const { resource } = await versions().item(versionId, formId).read();
  return resource ? { version: Number(resource.version), snapshot: parse(resource.snapshot, {}) } : null;
}

/** Used by scripts/reencrypt.js after a key rotation. */
export async function rewriteAllSecrets(transform) {
  let formCount = 0;
  let versionCount = 0;
  for await (const page of forms().items.readAll().getAsyncIterator()) {
    for (const doc of page.resources) {
      const def = transform(parse(doc.definition, {}));
      await forms().item(doc.id, doc.id).replace({ ...doc, definition: JSON.stringify(def) });
      formCount += 1;
    }
  }
  const modules = cosmosContainer('modules');
  for await (const page of modules.items.readAll().getAsyncIterator()) {
    for (const doc of page.resources) {
      const { auth, variables, headers } = transform({ auth: doc.auth, variables: doc.variables, headers: doc.headers });
      const spec = doc.spec ? encrypt(decrypt(doc.spec)) : doc.spec;
      await modules.item(doc.id, doc.id).replace({ ...doc, auth, variables, headers, spec });
    }
  }
  for await (const page of versions().items.readAll().getAsyncIterator()) {
    for (const doc of page.resources) {
      const snap = transform(parse(doc.snapshot, {}));
      await versions().item(doc.id, doc.formId).replace({ ...doc, snapshot: JSON.stringify(snap) });
      versionCount += 1;
    }
  }
  return { forms: formCount, versions: versionCount };
}
