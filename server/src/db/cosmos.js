import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Azure Cosmos DB for NoSQL.
 *
 * Containers (partition key):
 *   workspaces    /id      one document per workspace (owner + name)
 *   modules       /id      one document per module (sign-in + variables, secrets encrypted)
 *   forms         /id      one document per form (schema definition, secrets encrypted)
 *   formVersions  /formId  one document per saved version
 *   executions    /formId  one document per submission, removed automatically by TTL
 *
 * Authentication: COSMOS_KEY, or Entra ID (managed identity / az login) when no key is set.
 */

export const CONTAINERS = {
  workspaces: { id: 'workspaces', partitionKey: '/id' },
  modules: { id: 'modules', partitionKey: '/id' },
  forms: { id: 'forms', partitionKey: '/id' },
  formVersions: { id: 'formVersions', partitionKey: '/formId' },
  executions: { id: 'executions', partitionKey: '/formId', defaultTtl: -1 }, // TTL on, set per document
};

let client = null;
let database = null;
const containers = {};

export function cosmosContainer(name) {
  const c = containers[name];
  if (!c) throw new Error('Cosmos DB is not initialised. Call initCosmos() first.');
  return c;
}

export async function initCosmos(dbConfig = config.db) {
  const { CosmosClient } = await import('@azure/cosmos');
  const options = { endpoint: dbConfig.endpoint, userAgentSuffix: 'schema-forms' };
  if (dbConfig.key) {
    options.key = dbConfig.key;
  } else {
    const { DefaultAzureCredential } = await import('@azure/identity');
    options.aadCredentials = new DefaultAzureCredential({ managedIdentityClientId: dbConfig.managedIdentityClientId });
  }
  if (dbConfig.allowSelfSignedCert) {
    const https = await import('node:https');
    options.agent = new https.Agent({ rejectUnauthorized: false });
  }
  client = new CosmosClient(options);

  if (dbConfig.createContainers) {
    ({ database } = await client.databases.createIfNotExists({ id: dbConfig.database }));
    for (const [name, def] of Object.entries(CONTAINERS)) {
      const { container } = await database.containers.createIfNotExists({
        id: def.id,
        partitionKey: { paths: [def.partitionKey] },
        ...(def.defaultTtl !== undefined ? { defaultTtl: def.defaultTtl } : {}),
      });
      containers[name] = container;
    }
  } else {
    database = client.database(dbConfig.database);
    for (const [name, def] of Object.entries(CONTAINERS)) containers[name] = database.container(def.id);
    // fail fast with a clear message if something is missing or access is denied
    try {
      await Promise.all(Object.values(containers).map((c) => c.read()));
    } catch (e) {
      const reason =
        e.code === 404
          ? `database "${dbConfig.database}" or one of its containers (${Object.values(CONTAINERS).map((c) => c.id).join(', ')}) does not exist`
          : e.code === 403
            ? 'access denied. Give the app identity the "Cosmos DB Built-in Data Contributor" role'
            : e.message;
      throw new Error(`Cosmos DB: ${reason}. See docs/deployment.md.`);
    }
  }
  logger.info({ db: 'cosmos', database: dbConfig.database }, 'database ready');
}

export async function pingCosmos() {
  await database.read();
}

export function closeCosmos() {
  client?.dispose();
  client = null;
}
