import { usesCosmos } from '../db/index.js';
import * as sql from './sql-workspaces.js';
import * as cosmos from './cosmos-workspaces.js';

/** Workspaces (a user's own space for modules, forms and history). Uses Cosmos DB when DB_CLIENT=cosmos, otherwise SQL. */
const impl = () => (usesCosmos() ? cosmos : sql);

export const listWorkspaces = (...a) => impl().listWorkspaces(...a);
export const getWorkspace = (...a) => impl().getWorkspace(...a);
export const createWorkspace = (...a) => impl().createWorkspace(...a);
export const renameWorkspace = (...a) => impl().renameWorkspace(...a);
export const deleteWorkspace = (...a) => impl().deleteWorkspace(...a);
export const claimUnassigned = (...a) => impl().claimUnassigned(...a);
