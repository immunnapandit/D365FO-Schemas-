import fs from 'node:fs';
import path from 'node:path';
import knexFactory from 'knex';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as m001 from './migrations/001_initial.js';
import * as m002 from './migrations/002_form_category.js';
import * as m003 from './migrations/003_modules.js';
import { NodeSqliteClient } from './node-sqlite-client.js';

// Migrations are listed in code (not read from disk) so they work the same in dev, tests and Docker.
const migrations = [
  { name: '001_initial', module: m001 },
  { name: '002_form_category', module: m002 },
  { name: '003_modules', module: m003 },
];

const migrationSource = {
  getMigrations: async () => migrations,
  getMigrationName: (m) => m.name,
  getMigration: async (m) => m.module,
};

let db = null;

export function getDb() {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}

export async function initDb(dbConfig = config.db) {
  if (dbConfig.kind === 'sqlite' && dbConfig.connection.filename !== ':memory:') {
    fs.mkdirSync(path.dirname(dbConfig.connection.filename), { recursive: true });
  }
  // eslint-disable-next-line no-unused-vars
  const { kind, ...knexConfig } = dbConfig;
  db = knexFactory({
    ...knexConfig,
    ...(kind === 'sqlite'
      ? {
          client: NodeSqliteClient,
          pool: {
            min: 1,
            max: 1,
            afterCreate: (conn, done) => {
              if (dbConfig.connection.filename !== ':memory:') conn.exec('PRAGMA journal_mode = WAL');
              conn.exec('PRAGMA foreign_keys = ON');
              done();
            },
          },
        }
      : {}),
  });
  const [, applied] = await db.migrate.latest({ migrationSource });
  if (applied.length) logger.info({ applied }, 'database migrations applied');
  logger.info({ db: kind }, 'database ready');
  return db;
}

export async function pingDb() {
  await getDb().raw('select 1 as ok');
}

export async function closeDb() {
  if (db) {
    await db.destroy();
    db = null;
  }
}
