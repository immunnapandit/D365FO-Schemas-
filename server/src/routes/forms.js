import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { badRequest, notFound, HttpError } from '../http-errors.js';
import { canAccessForm, requireAdmin } from '../middleware/auth.js';
import * as forms from '../repositories/forms.js';
import * as executions from '../repositories/executions.js';
import * as modules from '../repositories/modules.js';
import { decryptModule } from './modules.js';
import { validateDefinition } from '../services/definition-schema.js';
import { containsMask, decryptDefinition, maskDefinition } from '../services/secrets.js';
import { execute, testAuth } from '../services/executor.js';
import { clearTokenCache } from '../services/outbound-auth.js';
import { trackEvent } from '../telemetry.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const executeLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimit.executePerMinute,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { message: 'Too many submissions. Please wait a minute and try again.', code: 'rate_limited' },
});

/** Normal users only get what they need to fill the form, never the auth/API configuration. */
function forUser(form, user) {
  if (user.isAdmin) return maskDefinition(form);
  return {
    id: form.id,
    name: form.name,
    description: form.description,
    icon: form.icon,
    category: form.category,
    version: form.version,
    updatedAt: form.updatedAt,
    formSchema: form.formSchema,
    uiSchema: form.uiSchema,
    api: { method: form.api?.method || 'POST' },
    auth: { type: form.auth?.type },
  };
}

async function loadAccessible(req) {
  const form = await forms.getForm(req.params.id);
  if (!form) throw notFound('Form not found');
  if (!canAccessForm(req.user, form)) throw notFound('Form not found'); // do not reveal it exists
  return form;
}

function decryptOrFail(form) {
  try {
    return decryptDefinition(form);
  } catch {
    throw new HttpError(500, 'Stored secrets could not be decrypted. Was SECRET_ENCRYPTION_KEY changed?', [], 'decrypt_failed');
  }
}

/** Fields an admin may send. id/version/created* are set by the server. */
function definitionFromBody(body) {
  if (!body || typeof body !== 'object') throw badRequest('Request body must be a JSON object');
  // eslint-disable-next-line no-unused-vars
  const { id, createdAt, createdBy, updatedAt, updatedBy, ...def } = body;
  const problems = validateDefinition(def);
  if (problems.length) throw badRequest('The schema definition is not valid', problems);
  // eslint-disable-next-line no-unused-vars
  const { version, ...clean } = def;
  return { def: clean, version };
}

/* ---------------- read ---------------- */

router.get(
  '/',
  wrap(async (req, res) => {
    const all = await forms.listForms();
    res.json(all.filter((f) => canAccessForm(req.user, f)));
  }),
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    res.json(forUser(await loadAccessible(req), req.user));
  }),
);

/* ---------------- admin: create / update / delete ---------------- */

router.post(
  '/',
  requireAdmin,
  wrap(async (req, res) => {
    const { def } = definitionFromBody(req.body);
    if (containsMask(def.auth) || containsMask(def.api)) {
      throw badRequest('A new form cannot contain masked secrets (••••••••). Enter the real value or a {{kv:...}} reference.');
    }
    const form = await forms.createForm(def, req.user);
    req.log.info({ formId: form.id }, 'form created');
    res.status(201).json(maskDefinition(form));
  }),
);

router.put(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const { def, version } = definitionFromBody(req.body);
    if (version === undefined) throw badRequest('"version" is required so concurrent edits can be detected.');
    const form = await forms.updateForm(req.params.id, def, version, req.user);
    clearTokenCache();
    req.log.info({ formId: form.id, version: form.version }, 'form updated');
    res.json(maskDefinition(form));
  }),
);

router.delete(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    await forms.deleteForm(req.params.id, req.user);
    req.log.info({ formId: req.params.id }, 'form deleted');
    res.status(204).end();
  }),
);

/* ---------------- admin: versions ---------------- */

router.get(
  '/:id/versions',
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await forms.listVersions(req.params.id));
  }),
);

router.get(
  '/:id/versions/:versionId',
  requireAdmin,
  wrap(async (req, res) => {
    const v = await forms.getVersion(req.params.id, req.params.versionId);
    if (!v) throw notFound('Version not found');
    res.json({ version: v.version, snapshot: maskDefinition(v.snapshot) });
  }),
);

router.post(
  '/:id/versions/:versionId/restore',
  requireAdmin,
  wrap(async (req, res) => {
    const v = await forms.getVersion(req.params.id, req.params.versionId);
    if (!v) throw notFound('Version not found');
    const s = v.snapshot;
    const def = {
      name: s.name,
      description: s.description,
      icon: s.icon,
      category: s.category,
      allowedRoles: s.allowedRoles,
      auth: s.auth,
      api: s.api,
      source: s.source,
      formSchema: s.formSchema,
      uiSchema: s.uiSchema,
    };
    const form = await forms.updateForm(req.params.id, def, req.body?.version, req.user, 'restore');
    clearTokenCache();
    req.log.info({ formId: form.id, from: v.version, to: form.version }, 'form version restored');
    res.json(maskDefinition(form));
  }),
);

/* ---------------- run ---------------- */

router.post(
  '/:id/execute',
  executeLimiter,
  wrap(async (req, res) => {
    const stored = await loadAccessible(req);
    const form = decryptOrFail(stored);
    const formData = req.body?.formData;
    if (formData !== undefined && (typeof formData !== 'object' || Array.isArray(formData) || formData === null)) {
      throw badRequest('"formData" must be an object');
    }
    const mod = decryptModule(await modules.getModuleByName(form.category));
    const result = await execute(form, formData ?? {}, mod);

    let executionId;
    try {
      executionId = await executions.recordExecution({ form: stored, user: req.user, result, requestId: req.id });
    } catch (e) {
      req.log.error({ err: e }, 'could not save execution history'); // never fail the user's submit because of history
    }
    req.log.info(
      { formId: form.id, ok: result.ok, stage: result.stage, status: result.status, durationMs: result.durationMs },
      result.ok ? 'form executed' : 'form execution failed',
    );
    trackEvent(
      'FormExecuted',
      { formId: form.id, ok: String(result.ok), stage: result.stage ?? '', status: String(result.status ?? '') },
      { durationMs: result.durationMs ?? 0 },
    );

    // normal users do not need the raw response of failed token calls (could reveal configuration)
    const out = { ...result, executionId, requestId: req.id };
    if (!req.user.isAdmin && result.stage === 'auth') delete out.response;
    res.json(out);
  }),
);

router.post(
  '/:id/test-auth',
  requireAdmin,
  wrap(async (req, res) => {
    const stored = await loadAccessible(req);
    const mod = decryptModule(await modules.getModuleByName(stored.category));
    res.json({ ...(await testAuth(decryptOrFail(stored), mod)), requestId: req.id });
  }),
);

router.get(
  '/:id/executions',
  wrap(async (req, res) => {
    await loadAccessible(req);
    const all = req.user.isAdmin && req.query.scope === 'all';
    res.json(
      await executions.listExecutions({
        formId: req.params.id,
        userId: all ? undefined : req.user.id,
        limit: req.query.limit,
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
      }),
    );
  }),
);

export default router;

export const executionsRouter = Router();

executionsRouter.get(
  '/',
  wrap(async (req, res) => {
    const all = req.user.isAdmin && req.query.scope === 'all';
    res.json(
      await executions.listExecutions({
        userId: all ? undefined : req.user.id,
        limit: req.query.limit,
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
      }),
    );
  }),
);

executionsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const ex = await executions.getExecution(req.params.id);
    if (!ex || (!req.user.isAdmin && ex.userId !== req.user.id)) throw notFound('Run not found');
    res.json(ex);
  }),
);

