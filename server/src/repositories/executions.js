import { usesCosmos } from '../db/index.js';
import * as sql from './sql-executions.js';
import * as cosmos from './cosmos-executions.js';

/** Submission history. Uses Cosmos DB when DB_CLIENT=cosmos, otherwise the SQL database (Knex). */
const impl = () => (usesCosmos() ? cosmos : sql);

export const recordExecution = (...a) => impl().recordExecution(...a);
export const listExecutions = (...a) => impl().listExecutions(...a);
export const getExecution = (...a) => impl().getExecution(...a);
export const purgeOldExecutions = (...a) => impl().purgeOldExecutions(...a);
