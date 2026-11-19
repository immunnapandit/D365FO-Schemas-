import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

// A local "Entra ID": we sign tokens with our own key and publish it as JWKS.
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
const jwksServer = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r));

const TENANT = '11111111-1111-1111-1111-111111111111';
const API_APP = '22222222-2222-2222-2222-222222222222';
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = ':memory:';
process.env.AUTH_MODE = 'entra';
process.env.AUTH_TENANT_ID = TENANT;
process.env.AUTH_SPA_CLIENT_ID = '33333333-3333-3333-3333-333333333333';
process.env.AUTH_API_AUDIENCE = `api://${API_APP},${API_APP}`;
process.env.AUTH_API_SCOPE = `api://${API_APP}/access_as_user`;
process.env.AUTH_JWKS_URI = `http://127.0.0.1:${jwksServer.address().port}/keys`;
process.env.ALLOWED_HOSTS = '127.0.0.1';

const { initDb, closeDb } = await import('../src/db/knex.js');
const { createApp } = await import('../src/app.js');

async function token({ roles = [], scp = 'access_as_user', aud = API_APP, exp = '1h', oid = 'user-1', name = 'Asha' } = {}) {
  return new SignJWT({ scp, roles, oid, name, preferred_username: `${name.toLowerCase()}@contoso.com`, tid: TENANT })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);
}
const as = async (opts) => ({ Authorization: `Bearer ${await token(opts)}` });

let app;
before(async () => {
  await initDb();
  app = createApp({ clientDist: '/nonexistent' });
});
after(async () => {
  await closeDb();
  jwksServer.close();
});

const simpleForm = (name, extra = {}) => ({
  name,
  auth: { type: 'none' },
  api: { method: 'POST', url: 'http://127.0.0.1:1/x' },
  formSchema: { type: 'object', properties: { a: { type: 'string' } } },
  ...extra,
});

test('config endpoint gives the browser what MSAL needs', async () => {
  const res = await request(app).get('/api/config').expect(200);
  assert.equal(res.body.authMode, 'entra');
  assert.equal(res.body.tenantId, TENANT);
  assert.equal(res.body.apiScope, `api://${API_APP}/access_as_user`);
});

test('no token -> 401', async () => {
  await request(app).get('/api/me').expect(401);
});

test('valid user token -> 200 with roles', async () => {
  const res = await request(app).get('/api/me').set(await as({ roles: ['SchemaForms.User'] })).expect(200);
  assert.equal(res.body.name, 'Asha');
  assert.equal(res.body.isAdmin, false);
});

test('token without an app role -> 403 with a helpful message', async () => {
  const res = await request(app).get('/api/me').set(await as({ roles: [] })).expect(403);
  assert.match(res.body.message, /SchemaForms\.User/);
});

test('expired, wrong-audience, wrong-scope and tampered tokens are rejected', async () => {
  await request(app).get('/api/me').set(await as({ roles: ['SchemaForms.User'], exp: Math.floor(Date.now() / 1000) - 600 })).expect(401);
  await request(app).get('/api/me').set(await as({ roles: ['SchemaForms.User'], aud: 'some-other-api' })).expect(401);
  await request(app).get('/api/me').set(await as({ roles: ['SchemaForms.User'], scp: 'User.Read' })).expect(401);
  const t = await token({ roles: ['SchemaForms.Admin'] });
  const [h, p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), name: 'Mallory' })).toString('base64url');
  await request(app).get('/api/me').set({ Authorization: `Bearer ${h}.${forged}.${s}` }).expect(401);
});

test('only admins can create, edit, delete or see configuration', async () => {
  const user = await as({ roles: ['SchemaForms.User'] });
  const admin = await as({ roles: ['SchemaForms.Admin'], oid: 'admin-1', name: 'Ravi' });

  await request(app).post('/api/forms').set(user).send(simpleForm('Nope')).expect(403);
  const created = (await request(app).post('/api/forms').set(admin).send(simpleForm('Open form')).expect(201)).body;
  assert.equal(created.createdBy, 'Ravi');

  const asUser = (await request(app).get(`/api/forms/${created.id}`).set(user).expect(200)).body;
  assert.equal(asUser.api.url, undefined, 'users do not see the API URL');
  assert.deepEqual(Object.keys(asUser.auth), ['type'], 'users do not see auth configuration');

  await request(app).put(`/api/forms/${created.id}`).set(user).send({ ...created }).expect(403);
  await request(app).get(`/api/forms/${created.id}/versions`).set(user).expect(403);
  await request(app).post(`/api/forms/${created.id}/test-auth`).set(user).expect(403);
  await request(app).delete(`/api/forms/${created.id}`).set(user).expect(403);

  // modules (sign-in, variables, imported file) and import are admin-only too
  const mod = (await request(app).post('/api/modules').set(admin).send({ name: 'Admin module', auth: { type: 'none' } }).expect(201)).body;
  await request(app).get('/api/modules').set(user).expect(403);
  await request(app).get(`/api/modules/${mod.id}`).set(user).expect(403);
  await request(app).get(`/api/modules/${mod.id}/spec`).set(user).expect(403);
  await request(app).post(`/api/modules/${mod.id}/test-auth`).set(user).expect(403);
  await request(app).put(`/api/modules/${mod.id}`).set(user).send(mod).expect(403);
  await request(app).post('/api/modules').set(user).send({ name: 'Nope', auth: { type: 'none' } }).expect(403);
  await request(app).post('/api/import/openapi').set(user).send({ content: '{}' }).expect(403);
});

test('allowedRoles hides a form from users without that role', async () => {
  const admin = await as({ roles: ['SchemaForms.Admin'] });
  const sales = await as({ roles: ['SchemaForms.User', 'Sales'], oid: 'u-sales' });
  const other = await as({ roles: ['SchemaForms.User'], oid: 'u-other' });
  const f = (await request(app).post('/api/forms').set(admin).send(simpleForm('Sales only', { allowedRoles: ['Sales'] })).expect(201)).body;

  assert.ok((await request(app).get('/api/forms').set(sales)).body.some((x) => x.id === f.id));
  assert.ok(!(await request(app).get('/api/forms').set(other)).body.some((x) => x.id === f.id));
  await request(app).get(`/api/forms/${f.id}`).set(other).expect(404);
  await request(app).post(`/api/forms/${f.id}/execute`).set(other).send({ formData: {} }).expect(404);
});

test('users only see their own run history; admins can see all', async () => {
  const admin = await as({ roles: ['SchemaForms.Admin'], oid: 'admin-1' });
  const u1 = await as({ roles: ['SchemaForms.User'], oid: 'u1', name: 'One' });
  const u2 = await as({ roles: ['SchemaForms.User'], oid: 'u2', name: 'Two' });
  const f = (await request(app).post('/api/forms').set(admin).send(simpleForm('History form')).expect(201)).body;

  const r1 = (await request(app).post(`/api/forms/${f.id}/execute`).set(u1).send({ formData: {} }).expect(200)).body;
  await request(app).post(`/api/forms/${f.id}/execute`).set(u2).send({ formData: {} }).expect(200);

  const mine = (await request(app).get(`/api/forms/${f.id}/executions?scope=all`).set(u1).expect(200)).body;
  assert.equal(mine.length, 1, 'scope=all is ignored for normal users');
  assert.equal(mine[0].userName, 'One');
  await request(app).get(`/api/executions/${r1.executionId}`).set(u2).expect(404);

  const all = (await request(app).get(`/api/forms/${f.id}/executions?scope=all`).set(admin).expect(200)).body;
  assert.equal(all.length, 2);
});
