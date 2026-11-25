import { Router } from 'express';
import { badRequest, conflict, forbidden, HttpError } from '../http-errors.js';
import * as workspaces from '../repositories/workspaces.js';
import { logger } from '../logger.js';

/**
 * Workspaces keep each user's modules, forms and history apart (e.g. "Bata", "Vista").
 * - Everyone works in their own workspaces and can import, build and run forms there.
 * - Admins (app role) can also open other people's workspaces, to help them.
 * - The browser sends the chosen workspace in the X-Workspace-Id header. Without it, the user's
 *   first workspace is used; a user without one gets "My workspace".
 * Sharing a workspace with other people is planned for later.
 */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const NAME_MAX = 60;
const DEFAULT_NAME = 'My workspace';

export const canOpen = (user, ws) => Boolean(user && ws && (ws.ownerId === user.id || user.isAdmin));

const workspaceNotFound = () =>
  new HttpError(404, 'This workspace does not exist or you have no access to it. Choose another workspace.', [], 'workspace_not_found');

const creating = new Map();

/**
 * The user's first workspace. A user without one gets "My workspace"; for the first admin it also takes
 * in everything made before workspaces existed, so no form or history is lost.
 */
export async function defaultWorkspace(user) {
  const mine = await workspaces.listWorkspaces({ ownerId: user.id });
  if (mine.length) return [...mine].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!creating.has(user.id)) {
    const job = (async () => {
      const ws = await workspaces.createWorkspace({ name: DEFAULT_NAME }, user);
      if (user.isAdmin) {
        const moved = await workspaces.claimUnassigned(ws.id);
        if (Object.values(moved).some(Boolean)) logger.info({ workspaceId: ws.id, moved }, 'existing forms moved into the first workspace');
      }
      return ws;
    })().finally(() => creating.delete(user.id));
    creating.set(user.id, job);
  }
  return creating.get(user.id);
}

/** Sets req.workspace from the X-Workspace-Id header (or the user's first workspace). */
export const useWorkspace = wrap(async (req, _res, next) => {
  const id = req.get('x-workspace-id');
  const ws = id ? await workspaces.getWorkspace(id) : await defaultWorkspace(req.user);
  if (!canOpen(req.user, ws)) throw workspaceNotFound();
  req.workspace = ws;
  req.canEdit = true; // owners and admins; read-only members will come with sharing
  next();
});

export function requireEditor(req, _res, next) {
  if (req.canEdit) return next();
  next(forbidden('You can only use the forms in this workspace, not change them.'));
}

function nameFromBody(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) throw badRequest('Give the workspace a name.');
  if (name.length > NAME_MAX) throw badRequest(`The name is too long (max ${NAME_MAX} characters).`);
  return name;
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function nameFree(ownerId, name, exceptId) {
  const mine = await workspaces.listWorkspaces({ ownerId });
  if (mine.some((w) => w.id !== exceptId && sameName(w.name, name))) throw conflict(`You already have a workspace called "${name}".`);
}

const view = (ws, user) => ({ ...ws, isMine: ws.ownerId === user.id, canEdit: canOpen(user, ws) });

async function loadOwnOrAdmin(req) {
  const ws = await workspaces.getWorkspace(req.params.id);
  if (!canOpen(req.user, ws)) throw workspaceNotFound();
  return ws;
}

const router = Router();

/** GET /api/workspaces[?scope=all]  your workspaces; admins add scope=all to also see everyone else's. */
router.get(
  '/',
  wrap(async (req, res) => {
    let mine = await workspaces.listWorkspaces({ ownerId: req.user.id });
    if (!mine.length) mine = [await defaultWorkspace(req.user)];
    let others = [];
    if (req.user.isAdmin && req.query.scope === 'all') {
      others = (await workspaces.listWorkspaces()).filter((w) => w.ownerId !== req.user.id);
    }
    res.json([...mine, ...others].map((w) => view(w, req.user)));
  }),
);

router.post(
  '/',
  wrap(async (req, res) => {
    const name = nameFromBody(req.body);
    await nameFree(req.user.id, name);
    const ws = await workspaces.createWorkspace({ name }, req.user);
    req.log.info({ workspaceId: ws.id }, 'workspace created');
    res.status(201).json(view(ws, req.user));
  }),
);

router.patch(
  '/:id',
  wrap(async (req, res) => {
    const ws = await loadOwnOrAdmin(req);
    const name = nameFromBody(req.body);
    await nameFree(ws.ownerId, name, ws.id);
    const renamed = await workspaces.renameWorkspace(ws.id, name);
    res.json(view(renamed, req.user));
  }),
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    const ws = await loadOwnOrAdmin(req);
    const ownersOthers = (await workspaces.listWorkspaces({ ownerId: ws.ownerId })).filter((w) => w.id !== ws.id);
    if (!ownersOthers.length) throw conflict('This is the only workspace. Create another workspace before you delete this one.');
    await workspaces.deleteWorkspace(ws.id);
    req.log.info({ workspaceId: ws.id }, 'workspace deleted');
    res.status(204).end();
  }),
);

export default router;
