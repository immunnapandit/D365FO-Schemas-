import { usesCosmos } from '../db/index.js';
import * as sql from './sql-modules.js';
import * as cosmos from './cosmos-modules.js';

/** Modules (shared sign-in + variables). Uses Cosmos DB when DB_CLIENT=cosmos, otherwise SQL. */
const impl = () => (usesCosmos() ? cosmos : sql);

export const listModules = (...a) => impl().listModules(...a);
export const getModule = (...a) => impl().getModule(...a);
export const getModuleByName = (...a) => impl().getModuleByName(...a);
export const createModule = (...a) => impl().createModule(...a);
export const updateModule = (...a) => impl().updateModule(...a);
export const deleteModule = (...a) => impl().deleteModule(...a);
export const getModuleSpec = (...a) => impl().getModuleSpec(...a);
export const setModuleSpec = (...a) => impl().setModuleSpec(...a);
