import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startUpstream } from './helpers.js';

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = ':memory:';
process.env.AUTH_MODE = 'easyauth';
process.env.ALLOWED_HOSTS = '127.0.0.1';

const { initDb, closeDb } = await import('../src/db/knex.js');
const { createApp } = await import('../src/app.js');
const forms = await import('../src/repositories/forms.js');

/** Headers for a user signed in by App Service Authentication. */
const as = (oid, name, roles = ['SchemaForms.User']) => ({
  'x-ms-client-principal': Buffer.from(
    JSON.stringify({
      role_typ: 'roles',
      claims: [
        { typ: 'name', val: name },
        { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
        ...roles.map((r) => ({ typ: 'roles', val: r })),
      ],
    }),
  ).toString('base64'),
});
const ADMIN = as('admin-1', 'Soumya', ['SchemaForms.Admin']);
const ASHA = as('asha', 'Asha');
const RAVI = as('ravi', 'Ravi');

let app;
let up;
before(async () => {
  await initDb();
  up = await startUpstream();
  app = createApp({ clientDist: '/nonexistent' });
});
after(async () => {
  await up.close();
  await closeDb();
});

const openapi = (key) => `openapi: 3.0.0
info: { title: Bata, version: '1' }
servers: [{ url: '${up.url}' }]
paths:
  /echo:
    post:
      summary: Create PO
      parameters:
        - name: subscription-key
          in: query
          required: true
          schema: { type: string }
          example: ${key}
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { poNumber: { type: string } } }
`;

test('forms made before workspaces move into the first admin workspace; nothing is lost', async () => {
  // a form saved before workspaces existed (no workspace)
  const old = await forms.createForm(
    { name: 'Old form', auth: { type: 'none' }, api: { method: 'POST', url: `${up.url}/echo` }, formSchema: { type: 'object', properties: {} } },
    { id: 'x', name: 'Someone' },
  );
  assert.equal(old.workspaceId, undefined);

  // a normal user signing in first does not take them
  const ashaWs = (await request(app).get('/api/workspaces').set(ASHA).expect(200)).body;
  assert.equal(ashaWs.length, 1);
  assert.equal(ashaWs[0].name, 'My workspace');
  assert.equal(ashaWs[0].isMine, true);
  assert.ok(!(await request(app).get('/api/forms').set(ASHA)).body.some((f) => f.id === old.id));

  // the first admin gets them in "My workspace"
  const [mine] = (await request(app).get('/api/workspaces').set(ADMIN).expect(200)).body;
  assert.equal(mine.name, 'My workspace');
  const list = (await request(app).get('/api/forms').set(ADMIN).set('X-Workspace-Id', mine.id).expect(200)).body;
  assert.ok(list.some((f) => f.id === old.id && f.workspaceId === mine.id));
});

test('only one default workspace is made, even when the first requests arrive together', async () => {
  const kiran = as('kiran', 'Kiran');
  await Promise.all([1, 2, 3, 4].map(() => request(app).get('/api/forms').set(kiran).expect(200)));
  assert.equal((await request(app).get('/api/workspaces').set(kiran).expect(200)).body.length, 1);
});

test('create, rename and delete workspaces, with clear errors', async () => {
  const bata = (await request(app).post('/api/workspaces').set(ASHA).send({ name: '  Bata ' }).expect(201)).body;
  assert.equal(bata.name, 'Bata');
  assert.equal(bata.ownerName, 'Asha');
  assert.equal((await request(app).post('/api/workspaces').set(ASHA).send({ name: 'bata' }).expect(409)).body.message, 'You already have a workspace called "bata".');
  await request(app).post('/api/workspaces').set(ASHA).send({ name: '   ' }).expect(400);
  await request(app).post('/api/workspaces').set(ASHA).send({ name: 'x'.repeat(61) }).expect(400);
  await request(app).post('/api/workspaces').set(RAVI).send({ name: 'Bata' }).expect(201); // names are per person

  const vista = (await request(app).post('/api/workspaces').set(ASHA).send({ name: 'Vista' }).expect(201)).body;
  await request(app).patch(`/api/workspaces/${vista.id}`).set(ASHA).send({ name: 'Bata' }).expect(409);
  assert.equal((await request(app).patch(`/api/workspaces/${vista.id}`).set(ASHA).send({ name: 'Vista Retail' }).expect(200)).body.name, 'Vista Retail');
  await request(app).patch(`/api/workspaces/${vista.id}`).set(RAVI).send({ name: 'Mine now' }).expect(404);
  await request(app).delete(`/api/workspaces/${vista.id}`).set(RAVI).expect(404);

  await request(app).delete(`/api/workspaces/${vista.id}`).set(ASHA).expect(204);
  const gone = await request(app).get('/api/forms').set(ASHA).set('X-Workspace-Id', vista.id).expect(404);
  assert.equal(gone.body.code, 'workspace_not_found');
  assert.ok(!(await request(app).get('/api/workspaces').set(ASHA)).body.some((w) => w.id === vista.id));

  // the last workspace cannot be deleted (Ravi made "Bata" first, so he has no "My workspace")
  const last = (await request(app).get('/api/workspaces').set(RAVI)).body;
  assert.deepEqual(last.map((w) => w.name), ['Bata']);
  assert.match((await request(app).delete(`/api/workspaces/${last[0].id}`).set(RAVI).expect(409)).body.message, /only workspace/);
});

test('the same file imported into two workspaces gives two separate modules, keys and histories', async () => {
  const ws = (await request(app).get('/api/workspaces').set(ASHA)).body;
  const bata = ws.find((w) => w.name === 'Bata');
  const test2 = (await request(app).post('/api/workspaces').set(ASHA).send({ name: 'Bata test copy' }).expect(201)).body;
  const inWs = (id) => ({ ...ASHA, 'X-Workspace-Id': id });

  const a = (await request(app).post('/api/import/openapi').set(inWs(bata.id)).send({ content: openapi('key-AAA'), commit: true }).expect(201)).body;
  const b = (await request(app).post('/api/import/openapi').set(inWs(test2.id)).send({ content: openapi('key-BBB'), commit: true }).expect(201)).body;
  assert.notEqual(a.module.id, b.module.id);
  assert.equal(a.module.name, b.module.name, 'same module name is fine in different workspaces');
  assert.notEqual(a.created[0].id, b.created[0].id);

  // each form runs with its own workspace's key
  await request(app).post(`/api/forms/${a.created[0].id}/execute`).set(inWs(bata.id)).send({ formData: { poNumber: 'PO-1' } }).expect(200);
  assert.equal(up.state.lastQuery['subscription-key'], 'key-AAA');
  await request(app).post(`/api/forms/${b.created[0].id}/execute`).set(inWs(test2.id)).send({ formData: { poNumber: 'PO-2' } }).expect(200);
  assert.equal(up.state.lastQuery['subscription-key'], 'key-BBB');

  // a form cannot be opened or run through the other workspace
  await request(app).get(`/api/forms/${a.created[0].id}`).set(inWs(test2.id)).expect(404);
  await request(app).post(`/api/forms/${a.created[0].id}/execute`).set(inWs(test2.id)).send({ formData: {} }).expect(404);
  await request(app).get(`/api/modules/${a.module.id}`).set(inWs(test2.id)).expect(404);

  // lists and history are per workspace
  const formsA = (await request(app).get('/api/forms').set(inWs(bata.id))).body.map((f) => f.id);
  assert.ok(formsA.includes(a.created[0].id) && !formsA.includes(b.created[0].id));
  const histA = (await request(app).get('/api/executions?scope=all').set(inWs(bata.id))).body;
  assert.deepEqual(histA.map((r) => r.formId), [a.created[0].id]);
  const runB = (await request(app).get('/api/executions').set(inWs(test2.id))).body[0];
  await request(app).get(`/api/executions/${runB.id}`).set(inWs(bata.id)).expect(404);
  await request(app).get(`/api/executions/${runB.id}`).set(inWs(test2.id)).expect(200);

  // re-importing into one workspace updates only that workspace
  const again = (await request(app).post('/api/import/openapi').set(inWs(bata.id)).send({ content: openapi('key-AAA'), commit: true }).expect(201)).body;
  assert.deepEqual(again.updated.map((f) => f.id), [a.created[0].id]);
  assert.equal(again.created.length, 0);
});

test('admins can list and open everyone else\'s workspaces; users only their own', async () => {
  const own = (await request(app).get('/api/workspaces?scope=all').set(ASHA).expect(200)).body;
  assert.ok(own.every((w) => w.isMine), 'scope=all is ignored for users');
  const all = (await request(app).get('/api/workspaces?scope=all').set(ADMIN).expect(200)).body;
  const ashaBata = all.find((w) => w.name === 'Bata' && w.ownerName === 'Asha');
  assert.ok(ashaBata && !ashaBata.isMine && ashaBata.canEdit);
  const seen = (await request(app).get('/api/forms').set(ADMIN).set('X-Workspace-Id', ashaBata.id).expect(200)).body;
  assert.ok(seen.length > 0);
});
