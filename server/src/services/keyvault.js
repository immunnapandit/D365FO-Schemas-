import { config } from '../config.js';
import { StageError } from './errors.js';

/**
 * {{kv:secret-name}} in a schema reads the secret from Azure Key Vault at run time.
 * Authentication uses DefaultAzureCredential: the app's managed identity in Azure,
 * or your `az login` on a developer machine. Values are cached for 5 minutes.
 */

const KV_REF = /\{\{\s*kv:([A-Za-z0-9-]+)\s*(?:\|[^}]*)?\}\}/g;
const TTL_MS = 5 * 60_000;
const cache = new Map(); // name -> { value, expiresAt }
let client = null;

async function getClient() {
  if (client) return client;
  if (!config.keyVaultUrl) {
    throw new StageError('config', 'This schema uses {{kv:...}} but KEY_VAULT_URL is not set on the server.');
  }
  const [{ DefaultAzureCredential }, { SecretClient }] = await Promise.all([
    import('@azure/identity'),
    import('@azure/keyvault-secrets'),
  ]);
  client = new SecretClient(config.keyVaultUrl, new DefaultAzureCredential());
  return client;
}

export function collectKvRefs(value) {
  const names = new Set();
  const text = JSON.stringify(value ?? null);
  for (const m of text.matchAll(KV_REF)) names.add(m[1]);
  return [...names];
}

async function getSecret(name) {
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const kv = await getClient();
  try {
    const secret = await kv.getSecret(name);
    cache.set(name, { value: secret.value, expiresAt: Date.now() + TTL_MS });
    return secret.value;
  } catch (e) {
    const reason = e.statusCode === 404 ? 'not found' : e.statusCode === 403 ? 'access denied for the app identity' : e.message;
    throw new StageError('config', `Key Vault secret "${name}": ${reason}`);
  }
}

/** Returns { name: value } for every {{kv:name}} used in the given objects. */
export async function resolveKvRefs(...objects) {
  const names = collectKvRefs(objects);
  if (!names.length) return {};
  const entries = await Promise.all(names.map(async (n) => [n, await getSecret(n)]));
  return Object.fromEntries(entries);
}

export function clearKvCache() {
  cache.clear();
}
