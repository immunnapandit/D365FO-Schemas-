/**
 * Re-encrypts every stored secret with the current SECRET_ENCRYPTION_KEY.
 *
 * Key rotation:
 *   1. set SECRET_ENCRYPTION_KEYS_PREVIOUS=<old key>  and  SECRET_ENCRYPTION_KEY=<new key>
 *   2. deploy, then run:  npm run reencrypt   (same environment variables)
 *   3. remove SECRET_ENCRYPTION_KEYS_PREVIOUS
 */
import { config, validateConfig } from '../src/config.js';
import { initDb, getDb, closeDb } from '../src/db/knex.js';
import { reencryptDefinition } from '../src/services/secrets.js';
import { logger } from '../src/logger.js';

const { errors } = validateConfig();
if (errors.length) {
  errors.forEach((e) => logger.fatal(e));
  process.exit(1);
}
if (!config.security.encryptionKey) {
  logger.fatal('SECRET_ENCRYPTION_KEY must be set.');
  process.exit(1);
}

await initDb();
const db = getDb();
let forms = 0;
let versions = 0;
await db.transaction(async (trx) => {
  for (const row of await trx('forms').select('id', 'definition')) {
    const def = reencryptDefinition(JSON.parse(row.definition));
    await trx('forms').where({ id: row.id }).update({ definition: JSON.stringify(def) });
    forms += 1;
  }
  for (const row of await trx('form_versions').select('id', 'snapshot')) {
    const snap = reencryptDefinition(JSON.parse(row.snapshot));
    await trx('form_versions').where({ id: row.id }).update({ snapshot: JSON.stringify(snap) });
    versions += 1;
  }
});
logger.info({ forms, versions }, 'secrets re-encrypted with the current key');
await closeDb();
