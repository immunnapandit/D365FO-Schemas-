import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModule, getModuleByName } from '../repositories/modules.js';
import { createForm } from '../repositories/forms.js';
import { validateDefinition, validateModule } from './definition-schema.js';
import { badRequest } from '../http-errors.js';

/**
 * Ready-made sets of forms a workspace can start with, e.g. the standard D365 F&O data entities
 * (customers, vendors, released products, sales orders). Only the files listed here are ever read.
 */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed', 'starters');
export const STARTERS = {
  d365: { file: 'd365-standard.json', title: 'D365 F&O standard forms' },
};

export async function loadStarter(kind) {
  const s = STARTERS[kind];
  if (!s) throw badRequest(`Unknown starter "${kind}". Use one of: ${Object.keys(STARTERS).join(', ')}.`);
  return JSON.parse(await fs.readFile(path.join(DIR, s.file), 'utf8'));
}

/** Adds the starter's module and forms to a workspace. A module of the same name already there is kept. */
export async function addStarter(kind, workspaceId, user) {
  const pack = await loadStarter(kind);
  const problems = validateModule(pack.module);
  for (const f of pack.forms) problems.push(...validateDefinition(f).map((p) => `${f.name}: ${p}`));
  if (problems.length) throw new Error(`Starter "${kind}" is not valid: ${problems.join('; ')}`);
  let mod = await getModuleByName(pack.module.name, workspaceId);
  if (!mod) mod = await createModule(pack.module, user, workspaceId);
  const forms = [];
  for (const f of pack.forms) forms.push(await createForm({ ...f, category: mod.name }, user, workspaceId));
  return { module: mod, forms };
}
