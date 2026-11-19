import { Router } from 'express';
import { badRequest, notFound, conflict, HttpError } from '../http-errors.js';
import { requireAdmin } from '../middleware/auth.js';
import * as modules from '../repositories/modules.js';
import * as forms from '../repositories/forms.js';
import { validateModule, validateDefinition } from '../services/definition-schema.js';
import { MASK, containsMask, decryptDefinition, maskDefinition } from '../services/secrets.js';
import { maskSpecContent, restoreSpecContent } from '../services/spec-secrets.js';
import { testAuth } from '../services/executor.js';
import { clearTokenCache } from '../services/outbound-auth.js';
import { planFromContent, ImportError } from '../services/import-plan.js';
import { sameName } from '../repositories/module-common.js';

/**
 * Modules group forms in the sidebar (forms.category = module name) and hold the sign-in and
 * {{variables}} shared by every form whose sign-in is "Use the module's sign-in".
 * Only admins can see or change them.
 */
const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAdmin);

function moduleFromBody(body) {
  if (!body || typeof body !== 'object') throw badRequest('Request body must be a JSON object');
  // eslint-disable-next-line no-unused-vars
  const { id, createdAt, createdBy, updatedAt, updatedBy, version, spec, ...mod } = body;
  mod.variables ??= {};
  mod.headers ??= {};
  const problems = validateModule(mod);
  if (problems.length) throw badRequest('The module is not valid', problems);
  return { mod, version };
}

export function decryptModule(mod) {
  if (!mod) return null;
  try {
    return decryptDefinition(mod);
  } catch {
    throw new HttpError(500, 'Stored secrets could not be decrypted. Was SECRET_ENCRYPTION_KEY changed?', [], 'decrypt_failed');
  }
}

const formsIn = async (name) => (await forms.listForms()).filter((f) => sameName(f.category, name));

router.get(
  '/',
  wrap(async (_req, res) => {
    res.json((await modules.listModules()).map(maskDefinition));
  }),
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    const mod = await modules.getModule(req.params.id);
    if (!mod) throw notFound('Module not found');
    res.json(maskDefinition(mod));
  }),
);

router.post(
  '/',
  wrap(async (req, res) => {
    const { mod } = moduleFromBody(req.body);
    if (containsMask(mod.auth) || containsMask(mod.variables) || containsMask(mod.headers)) throw badRequest('A new module cannot contain masked secrets (••••••••).');
    const created = await modules.createModule(mod, req.user);
    req.log.info({ moduleId: created.id }, 'module created');
    res.status(201).json(maskDefinition(created));
  }),
);

router.put(
  '/:id',
  wrap(async (req, res) => {
    const { mod, version } = moduleFromBody(req.body);
    if (version === undefined) throw badRequest('"version" is required so concurrent edits can be detected.');
    const before = await modules.getModule(req.params.id);
    if (!before) throw notFound('Module not found');
    const updated = await modules.updateModule(req.params.id, mod, version, req.user);
    // renamed -> move its forms along (they are linked by name)
    if (before.name !== updated.name) {
      for (const f of await formsIn(before.name)) {
        const full = await forms.getForm(f.id);
        // eslint-disable-next-line no-unused-vars
        const { id, version: v, createdAt, createdBy, updatedAt, updatedBy, ...def } = full;
        await forms.updateForm(f.id, { ...def, category: updated.name }, v, req.user);
      }
    }
    clearTokenCache();
    req.log.info({ moduleId: updated.id, version: updated.version }, 'module updated');
    res.json(maskDefinition(updated));
  }),
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const mod = await modules.getModule(req.params.id);
    if (!mod) throw notFound('Module not found');
    const inside = await formsIn(mod.name);
    if (inside.length) throw conflict(`The module still has ${inside.length} form(s). Delete or move them first.`);
    await modules.deleteModule(mod.id, req.user);
    res.status(204).end();
  }),
);

/** The OpenAPI file the module was imported from (admins view, edit and re-import it). */
router.get(
  '/:id/spec',
  wrap(async (req, res) => {
    const mod = await modules.getModule(req.params.id);
    if (!mod) throw notFound('Module not found');
    let spec;
    try {
      spec = await modules.getModuleSpec(mod.id);
    } catch {
      throw new HttpError(500, 'The stored file could not be decrypted. Was SECRET_ENCRYPTION_KEY changed?', [], 'decrypt_failed');
    }
    if (!spec) throw notFound('This module was not imported from a file.');
    // secret values in the file are hidden like every other module secret
    res.json({ ...spec, content: maskSpecContent(spec.content) });
  }),
);

/** Gets a token with the module's sign-in, so the admin knows it works before anyone submits. */
router.post(
  '/:id/test-auth',
  wrap(async (req, res) => {
    const mod = await modules.getModule(req.params.id);
    if (!mod) throw notFound('Module not found');
    const result = await testAuth({ auth: { type: 'module' }, category: mod.name }, decryptModule(mod));
    res.json({ ...result, requestId: req.id });
  }),
);

export default router;

/* ---------------- OpenAPI import ---------------- */

const MAX_SPEC_CHARS = 10_000_000; // the file is stored compressed (see packSpec), so 10 MB of YAML or JSON fits

export const importRouter = Router();
importRouter.use(requireAdmin);

function stripOrder(uiSchema) {
  if (!uiSchema || typeof uiSchema !== 'object') return undefined;
  // eslint-disable-next-line no-unused-vars
  const { 'ui:order': _order, ...rest } = uiSchema; // fields may have changed, a stale order would break the form
  return Object.keys(rest).length ? rest : undefined;
}

/**
 * POST /api/import/openapi
 * { content: "<yaml or json>", moduleName?: string, include?: string[] (request keys), commit?: boolean }
 * Without commit: returns what would be created (preview). With commit: creates/updates the module and forms.
 */
importRouter.post(
  '/openapi',
  wrap(async (req, res) => {
    const { moduleName, include, commit, fileName } = req.body ?? {};
    let { content } = req.body ?? {};
    if (typeof content === 'string' && content.length > MAX_SPEC_CHARS) throw badRequest('The file is too large (max 10 MB).');
    // the file was edited in the app: its secrets were shown hidden, so take them from the stored file again
    if (typeof content === 'string' && content.includes(MASK)) {
      const target = typeof moduleName === 'string' && moduleName.trim() ? await modules.getModuleByName(moduleName.trim()) : null;
      const stored = target ? await modules.getModuleSpec(target.id).catch(() => null) : null;
      const restored = restoreSpecContent(content, stored?.content);
      if (restored.missing.length) {
        throw badRequest(
          `The file contains a hidden value (${MASK}) that could not be matched to the stored file: ${[...new Set(restored.missing)].join(', ')}. Type the real value in its place.`,
        );
      }
      content = restored.content;
    }
    let plan;
    try {
      plan = planFromContent(content, { moduleName });
    } catch (e) {
      if (e instanceof ImportError) throw badRequest(e.message);
      throw e;
    }
    if (!plan.moduleName) throw badRequest('Give the module a name.');
    const existingModule = await modules.getModuleByName(plan.moduleName);
    const existingForms = existingModule ? await formsIn(existingModule.name) : [];
    const findForm = (name) => existingForms.find((f) => sameName(f.name, name));

    const selected = Array.isArray(include) ? plan.requests.filter((r) => include.includes(r.key)) : plan.requests;
    const problems = [];
    for (const r of selected) {
      for (const p of validateDefinition({ ...r.definition, category: plan.moduleName })) problems.push(`${r.name}: ${p}`);
    }

    if (!commit) {
      return res.json({
        moduleName: plan.moduleName,
        moduleExists: Boolean(existingModule),
        format: plan.format,
        auth: {
          type: plan.auth.type,
          ...(plan.auth.tokenUrl ? { tokenUrl: plan.auth.tokenUrl } : {}),
          // which sign-in fields have a value in the file (values themselves are not sent back)
          filled: Object.keys(plan.auth).filter((k) => k !== 'type' && plan.auth[k]),
        },
        authSource: plan.authSource,
        variables: plan.variables,
        variablesWithValue: plan.variables.filter((v) => plan.variableValues?.[v]),
        requests: plan.requests.map((r) => ({
          key: r.key,
          name: r.name,
          method: r.method,
          url: r.url,
          fieldCount: r.fieldCount,
          exists: Boolean(findForm(r.name)),
        })),
        problems,
      });
    }

    if (!selected.length) throw badRequest('Choose at least one request to import.');
    if (problems.length) throw badRequest('Some requests could not be turned into forms', problems);

    // 1) module: create it with the sign-in and variables from the file, or fill in what an existing module lacks.
    //    Values already set on the module are never overwritten by the file.
    const fileVars = Object.fromEntries(plan.variables.map((v) => [v, plan.variableValues?.[v] ?? '']));
    let mod = existingModule;
    if (!mod) {
      mod = await modules.createModule({ name: plan.moduleName, auth: plan.auth, variables: fileVars }, req.user);
    } else {
      const variables = { ...mod.variables };
      for (const [k, v] of Object.entries(fileVars)) if (!variables[k]) variables[k] = v;
      let auth = mod.auth;
      if ((!auth || auth.type === 'none') && plan.auth.type !== 'none') auth = plan.auth;
      else if (auth?.type === plan.auth.type) {
        auth = { ...auth };
        for (const [k, v] of Object.entries(plan.auth)) if (v && !auth[k]) auth[k] = v;
      }
      if (JSON.stringify(variables) !== JSON.stringify(mod.variables ?? {}) || JSON.stringify(auth) !== JSON.stringify(mod.auth)) {
        mod = await modules.updateModule(
          mod.id,
          { name: mod.name, description: mod.description, auth, variables, headers: mod.headers },
          mod.version,
          req.user,
        );
      }
    }

    // 2) forms: new requests are created, requests imported before are updated (new version)
    const created = [];
    const updated = [];
    for (const r of selected) {
      const match = findForm(r.name);
      if (match) {
        const full = await forms.getForm(match.id);
        const def = {
          name: full.name,
          description: full.description ?? r.definition.description,
          icon: full.icon,
          category: mod.name,
          allowedRoles: full.allowedRoles,
          auth: full.auth,
          api: r.definition.api,
          source: r.definition.source,
          formSchema: r.definition.formSchema,
          uiSchema: stripOrder(full.uiSchema),
        };
        const f = await forms.updateForm(full.id, def, full.version, req.user, 'import');
        updated.push({ id: f.id, name: f.name });
      } else {
        const f = await forms.createForm({ ...r.definition, category: mod.name }, req.user);
        created.push({ id: f.id, name: f.name });
      }
    }
    // keep the file with the module, so it can be viewed, edited and imported again later
    await modules.setModuleSpec(mod.id, { content, fileName: typeof fileName === 'string' ? fileName.slice(0, 200) : undefined }, req.user);
    clearTokenCache();
    req.log.info({ moduleId: mod.id, created: created.length, updated: updated.length }, 'OpenAPI imported');
    res.status(201).json({ module: maskDefinition((await modules.getModule(mod.id)) ?? mod), created, updated });
  }),
);
