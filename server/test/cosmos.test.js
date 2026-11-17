/**
 * Runs the main flows against Azure Cosmos DB.
 * Needs a Cosmos DB (for NoSQL) endpoint, e.g. the local emulator:
 *   docker run -p 8081:8081 mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview
 *   COSMOS_TEST_ENDPOINT=http://localhost:8081 npm test
 * Skipped when COSMOS_TEST_ENDPOINT is not set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { startUpstream, salesOrderDefinition } from './helpers.js';

const endpoint = process.env.COSMOS_TEST_ENDPOINT;
const EMULATOR_KEY = 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';
const skip = !endpoint && 'set COSMOS_TEST_ENDPOINT to run the Cosmos DB tests';

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'cosmos';
process.env.COSMOS_ENDPOINT = endpoint || 'http://127.0.0.1:1';
process.env.COSMOS_KEY = process.env.COSMOS_TEST_KEY || EMULATOR_KEY;
process.env.COSMOS_DATABASE = `schemaforms-test-${randomBytes(3).toString('hex')}`;
process.env.AUTH_MODE = 'none';
process.env.ALLOWED_HOSTS = '127.0.0.1';
process.env.HISTORY_RETENTION_DAYS = '30';

let app;
let up;
let formId;
let db;

before(async () => {
  if (skip) return;
  const { initDb } = await import('../src/db/index.js');
  const { createApp } = await import('../src/app.js');
  db = await import('../src/db/cosmos.js');
  await initDb();
  app = createApp({ clientDist: '/nonexistent' });
  up = await startUpstream();
});

after(async () => {
  if (skip) return;
  await up?.close();
  // remove the throw-away test database
  const { CosmosClient } = await import('@azure/cosmos');
  const client = new CosmosClient({ endpoint, key: process.env.COSMOS_KEY });
  await client.database(process.env.COSMOS_DATABASE).delete().catch(() => {});
  client.dispose();
  const { closeDb } = await import('../src/db/index.js');
  await closeDb();
});

test('cosmos: health check reaches the database', { skip }, async () => {
  const res = await request(app).get('/health/ready').expect(200);
  assert.equal(res.body.db, 'ok');
});

test('cosmos: create stores an encrypted secret and returns it masked', { skip }, async () => {
  const res = await request(app).post('/api/forms').send(salesOrderDefinition(up.url)).expect(201);
  formId = res.body.id;
  assert.equal(formId, 'test-sales-order');
  assert.equal(res.body.version, 1);
  assert.equal(res.body.auth.clientSecret, '••••••••');
  assert.equal(res.body.category, 'Sales and marketing');

  const { resource } = await db.cosmosContainer('forms').item(formId, formId).read();
  assert.ok(!resource.definition.includes('"good"'), 'plain secret must not be stored');
  assert.match(resource.definition, /enc:v1:/);

  const again = await request(app).post('/api/forms').send(salesOrderDefinition(up.url)).expect(201);
  assert.notEqual(again.body.id, formId, 'same name gets a different id');

  const list = (await request(app).get('/api/forms').expect(200)).body;
  assert.ok(list.some((f) => f.id === formId && f.icon === 'cart'));
});

test('cosmos: execute, then history with ttl', { skip }, async () => {
  const res = await request(app)
    .post(`/api/forms/${formId}/execute`)
    .send({ formData: { dataAreaId: 'USMF', customer: 'US-001', date: '2026-11-20' } })
    .expect(200);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.message, 'Sales order 001234 created.');

  const bad = await request(app).post(`/api/forms/${formId}/execute`).send({ formData: { customer: 'BAD' } }).expect(200);
  assert.equal(bad.body.ok, false);

  const history = (await request(app).get(`/api/forms/${formId}/executions`).expect(200)).body;
  assert.equal(history.length, 2);
  assert.equal(history[0].ok, false, 'newest first');
  const detail = (await request(app).get(`/api/executions/${history[1].id}`).expect(200)).body;
  assert.equal(detail.response.SalesOrderNumber, '001234');

  const all = (await request(app).get('/api/executions').expect(200)).body;
  assert.ok(all.length >= 2, 'cross-form history works');

  const { resource } = await db.cosmosContainer('executions').item(history[1].id, formId).read();
  assert.equal(resource.ttl, 30 * 86400);
});

test('cosmos: concurrent edits are refused, masked secret kept, versions and restore', { skip }, async () => {
  const current = (await request(app).get(`/api/forms/${formId}`).expect(200)).body;
  const saved = await request(app).put(`/api/forms/${formId}`).send({ ...current, description: 'edited' }).expect(200);
  assert.equal(saved.body.version, 2);
  await request(app).put(`/api/forms/${formId}`).send({ ...current, description: 'old tab' }).expect(409);

  const versions = (await request(app).get(`/api/forms/${formId}/versions`).expect(200)).body;
  assert.deepEqual(versions.map((v) => v.version), [2, 1]);
  const v1 = versions.find((v) => v.version === 1);
  const restored = await request(app).post(`/api/forms/${formId}/versions/${v1.id}/restore`).send({ version: 2 }).expect(200);
  assert.equal(restored.body.version, 3);
  assert.equal(restored.body.description, undefined);

  const run = await request(app).post(`/api/forms/${formId}/execute`).send({ formData: { customer: 'US-2' } }).expect(200);
  assert.equal(run.body.ok, true, 'secret still works after edit and restore');
});

test('cosmos: delete is soft and versioned', { skip }, async () => {
  await request(app).delete(`/api/forms/${formId}`).expect(204);
  await request(app).get(`/api/forms/${formId}`).expect(404);
  const { resource } = await db.cosmosContainer('forms').item(formId, formId).read();
  assert.equal(resource.isDeleted, true);
  const versions = (await request(app).get(`/api/forms/${formId}/versions`).expect(200)).body;
  assert.equal(versions[0].changeType, 'delete');
});

test('cosmos: modules keep secrets encrypted and detect concurrent edits', { skip }, async () => {
  const created = (
    await request(app)
      .post('/api/modules')
      .send({ name: 'Cosmos module', auth: { type: 'basic', username: 'u', password: 'p' }, variables: { tenantId: 't1' } })
      .expect(201)
  ).body;
  assert.equal(created.auth.password, '••••••••');
  const { resource } = await db.cosmosContainer('modules').item(created.id, created.id).read();
  assert.match(resource.auth.password, /^enc:v1:/);

  const saved = (await request(app).put(`/api/modules/${created.id}`).send({ ...created, description: 'x' }).expect(200)).body;
  assert.equal(saved.version, 2);
  await request(app).put(`/api/modules/${created.id}`).send({ ...created, description: 'old tab' }).expect(409);
  const list = (await request(app).get('/api/modules').expect(200)).body;
  assert.ok(list.some((m) => m.name === 'Cosmos module'));
  await request(app).delete(`/api/modules/${created.id}`).expect(204);
});
