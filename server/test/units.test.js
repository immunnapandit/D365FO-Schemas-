import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const { resolveDeep, resolveString } = await import('../src/services/template.js');
const { normalizeApiError } = await import('../src/services/errors.js');
const secrets = await import('../src/services/secrets.js');
const { validateDefinition } = await import('../src/services/definition-schema.js');
const { assertHostAllowed } = await import('../src/services/http.js');
const { validateConfig, config } = await import('../src/config.js');
const { collectKvRefs } = await import('../src/services/keyvault.js');

test('template: types are kept, empty optional values are dropped, filters work', () => {
  const ctx = { env: { BASE: 'https://x' }, form: { qty: 5, name: 'A', empty: undefined, d: '2026-01-02' } };
  assert.deepEqual(
    resolveDeep({ q: '{{form.qty}}', n: 'Name: {{form.name | upper}}', e: '{{form.empty}}', d: '{{form.d | datetime}}' }, ctx),
    { q: 5, n: 'Name: A', d: '2026-01-02T12:00:00Z' },
  );
  assert.equal(resolveString('{{env:BASE}}/data', ctx), 'https://x/data');
  assert.throws(() => resolveString('{{env:MISSING}}', ctx), /MISSING/);
  assert.throws(() => resolveString('{{form.a | nope}}', ctx), /Unknown filter/);
  assert.equal(resolveString('{{kv:my-secret}}', { kv: { 'my-secret': 's3' } }), 's3');
});

test('errors: F&O, Entra and ASP.NET formats', () => {
  assert.equal(
    normalizeApiError(500, { error: { message: 'An error has occurred.', innererror: { message: 'Real reason' } } }).message,
    'Real reason',
  );
  assert.equal(normalizeApiError(400, { error: 'invalid_client', error_description: 'AADSTS1' }).message, 'AADSTS1');
  const p = normalizeApiError(400, { title: 'Validation', errors: { Name: ['required'] } });
  assert.deepEqual(p.details, ['Name: required']);
  assert.equal(normalizeApiError(502, '').message, 'Request failed with HTTP 502');
});

test('secrets: encrypt/decrypt round trip, masking, placeholders untouched, restore', () => {
  const def = { auth: { type: 'basic', username: 'u', password: 'p@ss' }, api: { url: 'x', headers: { 'Ocp-Apim-Subscription-Key': '{{kv:apim}}' } } };
  const enc = secrets.encryptDefinition(def);
  assert.match(enc.auth.password, /^enc:v1:/);
  assert.equal(enc.auth.username, 'u');
  assert.equal(enc.api.headers['Ocp-Apim-Subscription-Key'], '{{kv:apim}}');
  assert.equal(secrets.decryptDefinition(enc).auth.password, 'p@ss');
  assert.equal(secrets.encryptDefinition(enc).auth.password, enc.auth.password, 'not encrypted twice');
  const masked = secrets.maskDefinition(enc);
  assert.equal(masked.auth.password, secrets.MASK);
  assert.equal(secrets.restoreMasked(masked.auth, enc.auth).password, enc.auth.password);
  const tampered = enc.auth.password.slice(0, -4) + 'AAAA';
  assert.throws(() => secrets.decrypt(tampered));
});

test('definition validation', () => {
  assert.deepEqual(
    validateDefinition({ name: 'ok', auth: { type: 'none' }, api: { url: 'https://x' }, formSchema: { type: 'object' } }),
    [],
  );
  const problems = validateDefinition({ name: '', auth: { type: 'basic' }, api: { url: 'u', method: 'FETCH' }, formSchema: { type: 'array' } });
  assert.ok(problems.some((p) => p.includes('"username" is required')));
  assert.ok(problems.some((p) => p.includes('api.method')));
  assert.ok(problems.some((p) => p.includes('formSchema.type must be "object"')));
});

test('ALLOWED_HOSTS matching', () => {
  const allowed = ['login.microsoftonline.com', '*.dynamics.com'];
  assert.doesNotThrow(() => assertHostAllowed('https://abc.sandbox.operations.dynamics.com/data', 'api', allowed));
  assert.throws(() => assertHostAllowed('https://dynamics.com.evil.io/', 'api', allowed), /ALLOWED_HOSTS/);
  assert.throws(() => assertHostAllowed('file:///etc/passwd', 'api', allowed), /http\/https/);
  assert.throws(() => assertHostAllowed('https://u:p@login.microsoftonline.com', 'api', allowed), /Credentials/);
});

test('Key Vault references are found in a schema', () => {
  assert.deepEqual(collectKvRefs({ a: '{{kv:fno-secret}}', b: ['x {{ kv:other | trim }}'] }).sort(), ['fno-secret', 'other']);
});

test('production configuration is checked at startup', () => {
  const prod = {
    ...config,
    isProd: true,
    db: { kind: 'mssql', connection: { server: '', database: '' } },
    auth: { ...config.auth, mode: 'none' },
    security: { allowedHosts: [], encryptionKey: '', corsOrigins: [] },
  };
  const { errors } = validateConfig(prod);
  const text = errors.join('\n');
  assert.match(text, /DB_HOST/);
  assert.match(text, /AUTH_MODE=none is not allowed/);
  assert.match(text, /SECRET_ENCRYPTION_KEY is required/);
  assert.match(text, /ALLOWED_HOSTS is required/);
});

test('key rotation: data encrypted with the old key can still be read and re-encrypted', async () => {
  const oldKey = Buffer.alloc(32, 9).toString('base64');
  config.security.encryptionKey = oldKey;
  const { encrypt: enc1 } = await import('../src/services/secrets.js?old');
  const cipherOld = enc1('top-secret');
  // new process state: new key + previous key
  config.security.encryptionKey = Buffer.alloc(32, 7).toString('base64');
  config.security.previousEncryptionKeys = [oldKey];
  const fresh = await import('../src/services/secrets.js?new');
  assert.equal(fresh.decrypt(cipherOld), 'top-secret');
  const re = fresh.reencryptDefinition({ auth: { clientSecret: cipherOld } });
  config.security.previousEncryptionKeys = [];
  const only = await import('../src/services/secrets.js?only');
  assert.equal(only.decrypt(re.auth.clientSecret), 'top-secret');
  assert.throws(() => only.decrypt(cipherOld));
});
