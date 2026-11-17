import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * All configuration comes from environment variables (or server/.env locally).
 * validateConfig() runs at startup and stops the app with a clear message if
 * something required for production is missing ("fail fast").
 */

// tests set their own environment; never read a developer's .env there
if (process.env.NODE_ENV !== 'test') dotenv.config({ quiet: true });

const env = process.env;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const list = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

function dbConfig() {
  const client = (env.DB_CLIENT || (isProd ? '' : 'sqlite')).toLowerCase();
  if (client === 'sqlite') {
    return {
      client: 'node-sqlite', // built-in node:sqlite, see db/node-sqlite-client.js
      kind: 'sqlite',
      connection: { filename: env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'app.db') },
      useNullAsDefault: true,
    };
  }
  if (client === 'mssql' || client === 'azuresql') {
    const managedIdentity = (env.DB_AUTH || 'sql').toLowerCase() === 'managed-identity';
    return {
      client: 'mssql',
      kind: 'mssql',
      connection: {
        server: env.DB_HOST,
        port: int(env.DB_PORT, 1433),
        database: env.DB_NAME,
        ...(managedIdentity
          ? {
              type: 'azure-active-directory-default',
              clientId: env.DB_MANAGED_IDENTITY_CLIENT_ID || undefined, // user-assigned identity (optional)
            }
          : { user: env.DB_USER, password: env.DB_PASSWORD }),
        encrypt: true,
        options: { encrypt: true, trustServerCertificate: bool(env.DB_TRUST_SERVER_CERT, false), appName: 'schema-forms' },
      },
      pool: { min: 0, max: int(env.DB_POOL_MAX, 10) },
    };
  }
  if (client === 'pg' || client === 'postgres' || client === 'postgresql') {
    return {
      client: 'pg',
      kind: 'pg',
      connection: {
        connectionString: env.DATABASE_URL,
        ssl: bool(env.DB_SSL, isProd) ? { rejectUnauthorized: bool(env.DB_SSL_REJECT_UNAUTHORIZED, true) } : false,
      },
      pool: { min: 0, max: int(env.DB_POOL_MAX, 10) },
    };
  }
  if (client === 'cosmos' || client === 'cosmosdb') {
    // COSMOS_CONNECTION_STRING ("AccountEndpoint=...;AccountKey=...;", as shown in the portal) or endpoint + key
    const cs = Object.fromEntries(
      String(env.COSMOS_CONNECTION_STRING || '')
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf('=');
          return [p.slice(0, i).toLowerCase(), p.slice(i + 1)];
        }),
    );
    const endpoint = env.COSMOS_ENDPOINT || cs.accountendpoint || '';
    const key = env.COSMOS_KEY || cs.accountkey || '';
    const keyAuth = !!key;
    return {
      kind: 'cosmos',
      endpoint,
      key,
      database: env.COSMOS_DATABASE || 'schemaforms',
      // with a key the app can create the database and containers itself;
      // with Entra ID (managed identity) they must exist already (data-plane RBAC cannot create them)
      createContainers: bool(env.COSMOS_CREATE_CONTAINERS, keyAuth),
      managedIdentityClientId: env.COSMOS_MANAGED_IDENTITY_CLIENT_ID || undefined,
      // only for the local Cosmos DB emulator, which uses a self-signed certificate
      allowSelfSignedCert: bool(env.COSMOS_ALLOW_SELF_SIGNED_CERT, false),
    };
  }
  return { client, kind: client || 'none' };
}

export const config = {
  isProd,
  isTest,
  port: int(env.PORT, 4000),
  logLevel: env.LOG_LEVEL || (isTest ? 'silent' : isProd ? 'info' : 'debug'),
  trustProxy: bool(env.TRUST_PROXY, isProd), // behind Azure front ends
  publicUrl: env.PUBLIC_URL || '',

  db: dbConfig(),

  auth: {
    // entra    = React signs in with MSAL, API validates the Entra ID access token
    // easyauth = App Service / Container Apps Authentication does the login in front of the app
    // none     = local development only (refused in production)
    mode: (env.AUTH_MODE || (isProd ? '' : 'none')).toLowerCase(),
    tenantId: env.AUTH_TENANT_ID || '',
    spaClientId: env.AUTH_SPA_CLIENT_ID || '',
    apiAudience: list(env.AUTH_API_AUDIENCE), // e.g. api://<api-app-id>,<api-app-id>
    apiScope: env.AUTH_API_SCOPE || '', // e.g. api://<api-app-id>/access_as_user
    issuer: env.AUTH_ISSUER || (env.AUTH_TENANT_ID ? `https://login.microsoftonline.com/${env.AUTH_TENANT_ID}/v2.0` : ''),
    jwksUri:
      env.AUTH_JWKS_URI ||
      (env.AUTH_TENANT_ID ? `https://login.microsoftonline.com/${env.AUTH_TENANT_ID}/discovery/v2.0/keys` : ''),
    adminRole: env.AUTH_ADMIN_ROLE || 'SchemaForms.Admin',
    userRole: env.AUTH_USER_ROLE || 'SchemaForms.User',
    requireRole: bool(env.AUTH_REQUIRE_ROLE, true),
  },

  security: {
    allowedHosts: list(env.ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    encryptionKey: env.SECRET_ENCRYPTION_KEY || '',
    previousEncryptionKeys: list(env.SECRET_ENCRYPTION_KEYS_PREVIOUS),
    corsOrigins: list(env.CORS_ORIGIN),
  },

  keyVaultUrl: env.KEY_VAULT_URL || '',
  appInsightsConnectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING || '',

  requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 60000),
  rateLimit: {
    apiPerMinute: int(env.RATE_LIMIT_API_PER_MIN, 300),
    executePerMinute: int(env.RATE_LIMIT_EXECUTE_PER_MIN, 30),
  },
  history: {
    retentionDays: int(env.HISTORY_RETENTION_DAYS, 90),
    storePayloads: bool(env.HISTORY_STORE_PAYLOADS, true),
    maxPayloadBytes: int(env.HISTORY_MAX_PAYLOAD_BYTES, 32 * 1024),
  },
  seedSampleForms: bool(env.SEED_SAMPLE_FORMS, !isProd),
};

export function validateConfig(c = config) {
  const errors = [];
  const warnings = [];

  // database
  if (!['sqlite', 'mssql', 'pg', 'cosmos'].includes(c.db.kind)) {
    errors.push('DB_CLIENT must be one of: cosmos (Azure Cosmos DB), mssql (Azure SQL), pg (PostgreSQL), sqlite (local dev only).');
  }
  if (c.db.kind === 'cosmos') {
    if (!c.db.endpoint) errors.push('COSMOS_CONNECTION_STRING (or COSMOS_ENDPOINT) is required for Cosmos DB.');
    if (c.isProd && c.db.allowSelfSignedCert) errors.push('COSMOS_ALLOW_SELF_SIGNED_CERT is only for the local emulator.');
  }
  if (c.db.kind === 'mssql') {
    if (!c.db.connection.server) errors.push('DB_HOST is required for Azure SQL.');
    if (!c.db.connection.database) errors.push('DB_NAME is required for Azure SQL.');
    if (c.db.connection.type !== 'azure-active-directory-default' && (!c.db.connection.user || !c.db.connection.password)) {
      errors.push('DB_USER and DB_PASSWORD are required (or set DB_AUTH=managed-identity).');
    }
  }
  if (c.db.kind === 'pg' && !c.db.connection.connectionString) errors.push('DATABASE_URL is required for PostgreSQL.');
  if (c.isProd && c.db.kind === 'sqlite') {
    errors.push('SQLite is for local development only. In production use DB_CLIENT=mssql (Azure SQL) or pg.');
  }

  // user authentication
  const mode = c.auth.mode;
  if (!['entra', 'easyauth', 'none'].includes(mode)) {
    errors.push('AUTH_MODE must be "entra" or "easyauth" (or "none" for local development).');
  }
  if (mode === 'none' && c.isProd) errors.push('AUTH_MODE=none is not allowed when NODE_ENV=production.');
  if (mode === 'entra') {
    if (!c.auth.tenantId) errors.push('AUTH_TENANT_ID is required for AUTH_MODE=entra.');
    if (!c.auth.spaClientId) errors.push('AUTH_SPA_CLIENT_ID is required for AUTH_MODE=entra.');
    if (!c.auth.apiAudience.length) errors.push('AUTH_API_AUDIENCE is required for AUTH_MODE=entra.');
    if (!c.auth.apiScope) errors.push('AUTH_API_SCOPE is required for AUTH_MODE=entra.');
  }

  // secrets
  if (c.security.encryptionKey) {
    const len = Buffer.from(c.security.encryptionKey, 'base64').length;
    if (len !== 32) errors.push('SECRET_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).');
  } else if (c.isProd) {
    errors.push('SECRET_ENCRYPTION_KEY is required in production (openssl rand -base64 32).');
  } else {
    warnings.push('SECRET_ENCRYPTION_KEY not set: using a development key. Never do this in production.');
  }
  for (const k of c.security.previousEncryptionKeys || []) {
    if (Buffer.from(k, 'base64').length !== 32) errors.push('Every key in SECRET_ENCRYPTION_KEYS_PREVIOUS must be 32 bytes, base64.');
  }

  // outbound calls
  if (!c.security.allowedHosts.length) {
    if (c.isProd) errors.push('ALLOWED_HOSTS is required in production (e.g. login.microsoftonline.com,*.dynamics.com).');
    else warnings.push('ALLOWED_HOSTS is empty: the server may call any host (development only).');
  }

  return { errors, warnings };
}
