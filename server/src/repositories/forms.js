import { usesCosmos } from '../db/index.js';
import * as sql from './sql-forms.js';
import * as cosmos from './cosmos-forms.js';

/** Forms + versions. Uses Cosmos DB when DB_CLIENT=cosmos, otherwise the SQL database (Knex). */
const impl = () => (usesCosmos() ? cosmos : sql);

export const listForms = (...a) => impl().listForms(...a);
export const getForm = (id) => impl().getForm(id);
export const countForms = (...a) => impl().countForms(...a);
export const createForm = (...a) => impl().createForm(...a);
export const updateForm = (...a) => impl().updateForm(...a);
export const deleteForm = (...a) => impl().deleteForm(...a);
export const listVersions = (...a) => impl().listVersions(...a);
export const getVersion = (...a) => impl().getVersion(...a);
