import { config } from '../config.js';
import * as sql from './knex.js';
import { initCosmos, pingCosmos, closeCosmos } from './cosmos.js';

/** One entry point for start-up, health checks and shutdown, whatever database is configured. */

export const usesCosmos = (c = config) => c.db.kind === 'cosmos';

export async function initDb() {
  if (usesCosmos()) return initCosmos();
  return sql.initDb();
}

export async function pingDb() {
  if (usesCosmos()) return pingCosmos();
  return sql.pingDb();
}

export async function closeDb() {
  if (usesCosmos()) return closeCosmos();
  return sql.closeDb();
}
