import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startUpstream, salesOrderDefinition } from './helpers.js';

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = ':memory:';
process.env.AUTH_MODE = 'none';
process.env.ALLOWED_HOSTS = '127.0.0.1';
process.env.FNO_SECRET_TEST = 'env-secret-value';

const { initDb, closeDb, getDb } = await import('../src/db/knex.js');
const { createApp } = await import('../src/app.js');
const { clearTokenCache } = await import('../src/services/outbound-auth.js');

let app;
let up;
let formId;

before(async () => {
  await initDb();
  app = createApp({ clientDist: '/nonexistent' });
  up = await startUpstream();
});
after(async () => {
  await up.close();
  await closeDb();
});

test('health and config are public', async () => {
  await request(app).get('/health/live').expect(200);
  const ready = await request(app).get('/health/ready').expect(200);
  assert.equal(ready.body.db, 'ok');
  const cfg = await request(app).get('/api/config').expect(200);
  assert.equal(cfg.body.authMode, 'none');
});

test('rejects an invalid schema definition with readable problems', async () => {
  const res = await request(app)
    .post('/api/forms')
    .send({ name: 'x', auth: { type: 'oauth2_client_credentials' }, api: {}, formSchema: { type: 'nope' }, extra: 1 })
    .expect(400);
  const text = res.body.details.join('\n');
  assert.match(text, /tokenUrl/);
  assert.match(text, /api: "url" is required/);
  assert.match(text, /unknown property "extra"/);
  assert.match(text, /formSchema/);
});

test('creates a form; secrets are encrypted in the DB and masked in responses', async () => {
  const res = await request(app).post('/api/forms').send(salesOrderDefinition(up.url)).expect(201);
  formId = res.body.id;
  assert.equal(formId, 'test-sales-order');
  assert.equal(res.body.version, 1);
  assert.equal(res.body.auth.clientSecret, '••••••••');
  assert.equal(res.body.createdBy, 'Local Developer');

  const row = await getDb()('forms').where({ id: formId }).first();
  assert.ok(!row.definition.includes('"good"'), 'plain secret must not be stored');
  assert.match(row.definition, /enc:v1:/);

  const list = await request(app).get('/api/forms').expect(200);
  assert.ok(list.body.some((f) => f.id === formId));
});

test('a new form cannot contain masked secrets', async () => {
  const def = salesOrderDefinition(up.url, { name: 'Masked' });
  def.auth.clientSecret = '••••••••';
  await request(app).post('/api/forms').send(def).expect(400);
});

test('executes successfully: token + API call + success message + history', async () => {
  clearTokenCache();
  const res = await request(app)
    .post(`/api/forms/${formId}/execute`)
    .send({ formData: { dataAreaId: 'USMF', customer: 'US-001', date: '2026-11-20' } })
    .expect(200);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.status, 201);
  assert.equal(res.body.message, 'Sales order 001234 created.');
  assert.equal(res.body.auth.cached, false);
  assert.ok(res.body.executionId);
  assert.ok(res.body.requestId);
  assert.deepEqual(up.state.lastBody, {
    dataAreaId: 'usmf',
    OrderingCustomerAccountNumber: 'US-001',
    RequestedReceiptDate: '2026-11-20T12:00:00Z',
  });

  const second = await request(app)
    .post(`/api/forms/${formId}/execute`)
    .send({ formData: { customer: 'US-002' } })
    .expect(200);
  assert.equal(second.body.auth.cached, true, 'token must come from cache');
  assert.equal(up.state.tokenCalls, 1);
  assert.equal(up.state.lastBody.dataAreaId, 'usmf', 'default from formSchema applied');

  const history = await request(app).get(`/api/forms/${formId}/executions`).expect(200);
  assert.equal(history.body.length, 2);
  const detail = await request(app).get(`/api/executions/${history.body[0].id}`).expect(200);
  assert.equal(detail.body.ok, true);
  assert.equal(detail.body.response.SalesOrderNumber, '001234');
});

test('shows the F&O infolog message instead of "An error has occurred"', async () => {
  const res = await request(app).post(`/api/forms/${formId}/execute`).send({ formData: { customer: 'BAD' } }).expect(200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.stage, 'api');
  assert.equal(res.body.status, 500);
  assert.match(res.body.message, /Customer BAD does not exist/);
  assert.deepEqual(res.body.details, ['Customer BAD does not exist.']);
});

test('validates form data on the server too', async () => {
  const res = await request(app).post(`/api/forms/${formId}/execute`).send({ formData: { date: 'x' } }).expect(200);
  assert.equal(res.body.stage, 'validation');
  assert.ok(res.body.details.some((d) => d.startsWith('customer: is required')));
});

test('gets a fresh token and retries once when the cached token is rejected (401)', async () => {
  const before = up.state.tokenCalls;
  up.state.revoked.add(`tok-${up.state.tokenSeq}`);
  const res = await request(app).post(`/api/forms/${formId}/execute`).send({ formData: { customer: 'US-003' } }).expect(200);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(up.state.tokenCalls, before + 1);
});

test('optimistic concurrency: stale version gets 409, masked secret is kept on update', async () => {
  const current = (await request(app).get(`/api/forms/${formId}`).expect(200)).body;
  assert.equal(current.version, 1);

  const ok = await request(app)
    .put(`/api/forms/${formId}`)
    .send({ ...current, description: 'edited once' })
    .expect(200);
  assert.equal(ok.body.version, 2);

  const stale = await request(app)
    .put(`/api/forms/${formId}`)
    .send({ ...current, description: 'edited from an old tab' })
    .expect(409);
  assert.match(stale.body.message, /changed by/);

  // masked secret kept -> execution still works
  clearTokenCache();
  const run = await request(app).post(`/api/forms/${formId}/execute`).send({ formData: { customer: 'US-9' } }).expect(200);
  assert.equal(run.body.ok, true);
});

test('version history and restore', async () => {
  const versions = (await request(app).get(`/api/forms/${formId}/versions`).expect(200)).body;
  assert.deepEqual(
    versions.map((v) => [v.version, v.changeType]),
    [
      [2, 'update'],
      [1, 'create'],
    ],
  );
  const v1 = versions.find((v) => v.version === 1);
  const snap = (await request(app).get(`/api/forms/${formId}/versions/${v1.id}`).expect(200)).body;
  assert.equal(snap.snapshot.auth.clientSecret, '••••••••');

  const restored = await request(app)
    .post(`/api/forms/${formId}/versions/${v1.id}/restore`)
    .send({ version: 2 })
    .expect(200);
  assert.equal(restored.body.version, 3);
  assert.equal(restored.body.description, undefined);

  clearTokenCache();
  const run = await request(app).post(`/api/forms/${formId}/execute`).send({ formData: { customer: 'US-10' } }).expect(200);
  assert.equal(run.body.ok, true, 'restored form still has its secret');
});

test('wrong client secret is reported as an authentication failure', async () => {
  const current = (await request(app).get(`/api/forms/${formId}`).expect(200)).body;
  await request(app)
    .put(`/api/forms/${formId}`)
    .send({ ...current, auth: { ...current.auth, clientSecret: 'wrong' } })
    .expect(200);
  const res = await request(app).post(`/api/forms/${formId}/execute`).send({ formData: { customer: 'X' } }).expect(200);
  assert.equal(res.body.stage, 'auth');
  assert.match(res.body.message, /^Sign-in failed: The client secret is wrong/);
  assert.ok(res.body.details.includes('Error code: AADSTS7000215'));

  const t = await request(app).post(`/api/forms/${formId}/test-auth`).expect(200);
  assert.equal(t.body.ok, false);
});

test('hosts outside ALLOWED_HOSTS are blocked', async () => {
  const def = salesOrderDefinition(up.url, { name: 'Blocked host' });
  def.auth = { type: 'none' };
  def.api.url = 'https://evil.example.com/steal';
  const created = (await request(app).post('/api/forms').send(def).expect(201)).body;
  const res = await request(app).post(`/api/forms/${created.id}/execute`).send({ formData: { customer: 'A' } }).expect(200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /not in ALLOWED_HOSTS/);
});

test('secrets from env are masked in the request preview and history', async () => {
  const def = {
    name: 'Secret in body',
    auth: { type: 'none' },
    api: {
      method: 'POST',
      url: `${up.url}/data/SalesOrderHeadersV2`,
      headers: { Authorization: 'Bearer tok-999' },
      bodyTemplate: { OrderingCustomerAccountNumber: '{{form.c}}', apiSecret: '{{env:FNO_SECRET_TEST}}' },
    },
    formSchema: { type: 'object', properties: { c: { type: 'string' } } },
  };
  const created = (await request(app).post('/api/forms').send(def).expect(201)).body;
  assert.equal(created.api.headers.Authorization, '••••••••', 'secret header masked');
  const res = await request(app).post(`/api/forms/${created.id}/execute`).send({ formData: { c: 'C1' } }).expect(200);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(up.state.lastBody.apiSecret, 'env-secret-value', 'real value sent upstream');
  assert.equal(res.body.request.body.apiSecret, '••••••••', 'masked in what the user sees');
  const row = await getDb()('executions').where({ id: res.body.executionId }).first();
  assert.ok(!row.request_json.includes('env-secret-value'));
});

test('GET requests are retried on 503', async () => {
  const def = {
    name: 'Flaky',
    auth: { type: 'bearer_static', token: 'tok-static' },
    api: { method: 'GET', url: `${up.url}/data/Flaky` },
    formSchema: { type: 'object', properties: {} },
  };
  const created = (await request(app).post('/api/forms').send(def).expect(201)).body;
  const res = await request(app).post(`/api/forms/${created.id}/execute`).send({ formData: {} }).expect(200);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(up.state.flaky, 2);
});

test('delete is soft and recorded in versions', async () => {
  await request(app).delete(`/api/forms/${formId}`).expect(204);
  await request(app).get(`/api/forms/${formId}`).expect(404);
  const row = await getDb()('forms').where({ id: formId }).first();
  assert.ok(row && Boolean(row.is_deleted));
  const versions = (await request(app).get(`/api/forms/${formId}/versions`).expect(200)).body;
  assert.equal(versions[0].changeType, 'delete');
});

test('unknown API routes return JSON 404 with request id', async () => {
  const res = await request(app).get('/api/nope').expect(404);
  assert.ok(res.body.requestId);
});

test('oauth2_password: signs in with a service account, password is encrypted and masked', async () => {
  const def = salesOrderDefinition(up.url, { name: 'Password grant' });
  def.auth = {
    type: 'oauth2_password',
    tokenUrl: `${up.url}/tenant/oauth2/v2.0/token`,
    clientId: 'cid',
    username: 'svc-user',
    password: 'svc-pass',
    scope: 'https://fno.example/.default',
  };
  const created = (await request(app).post('/api/forms').send(def).expect(201)).body;
  assert.equal(created.auth.password, '••••••••');
  assert.equal(created.auth.username, 'svc-user');
  clearTokenCache();
  const ok = await request(app).post(`/api/forms/${created.id}/execute`).send({ formData: { customer: 'US-1' } }).expect(200);
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(up.state.lastTokenRequest.grant_type, 'password');
  assert.equal(up.state.lastTokenRequest.client_id, 'cid');

  await request(app)
    .put(`/api/forms/${created.id}`)
    .send({ ...created, auth: { ...created.auth, password: 'wrong' } })
    .expect(200);
  const bad = await request(app).post(`/api/forms/${created.id}/execute`).send({ formData: { customer: 'US-1' } }).expect(200);
  assert.equal(bad.body.stage, 'auth');
  assert.match(bad.body.message, /username or password is wrong/);
  assert.ok(bad.body.details.includes('Error code: AADSTS50126'));
});

test('category and icon are stored, listed and validated', async () => {
  const def = salesOrderDefinition(up.url, { name: 'Categorised', category: 'Procurement', icon: 'vendor' });
  const created = (await request(app).post('/api/forms').send(def).expect(201)).body;
  assert.equal(created.category, 'Procurement');
  const listed = (await request(app).get('/api/forms').expect(200)).body.find((f) => f.id === created.id);
  assert.equal(listed.category, 'Procurement');
  assert.equal(listed.icon, 'vendor');
  await request(app).post('/api/forms').send({ ...def, name: 'Bad icon', icon: 'nope' }).expect(400);
});

test('when the API host does not answer, the result says sign-in worked and the API call failed', async () => {
  const def = salesOrderDefinition(up.url, { name: 'Unreachable API' });
  def.api.url = 'http://127.0.0.1:1/data/SalesOrderHeadersV2';
  const created = (await request(app).post('/api/forms').send(def).expect(201)).body;
  clearTokenCache();
  const res = await request(app).post(`/api/forms/${created.id}/execute`).send({ formData: { customer: 'X' } }).expect(200);
  assert.equal(res.body.stage, 'network');
  assert.match(res.body.message, /Could not reach 127\.0\.0\.1:1/);
  assert.equal(res.body.auth.type, 'oauth2_client_credentials', 'sign-in info is included');
});
