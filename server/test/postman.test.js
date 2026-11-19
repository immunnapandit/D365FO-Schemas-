import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startUpstream } from './helpers.js';

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = ':memory:';
process.env.AUTH_MODE = 'none';
process.env.ALLOWED_HOSTS = '127.0.0.1';

const { initDb, closeDb } = await import('../src/db/knex.js');
const { createApp } = await import('../src/app.js');
const { clearTokenCache } = await import('../src/services/outbound-auth.js');
const { buildPostmanPlan } = await import('../src/services/postman.js');

let app;
let up;

/** Same shape as Postman's "Export collection" (v2.1) with OAuth 2.0 on the collection. */
const collection = (baseUrl, { secret = '' } = {}) => ({
  info: {
    _postman_id: 'c09ee719-2c55-44a8-b7fe-6b3567ad0dfa',
    name: 'F&O OData - Customer and Sales order',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: {
    type: 'oauth2',
    oauth2: [
      { key: 'grant_type', value: 'client_credentials', type: 'string' },
      { key: 'accessTokenUrl', value: `${baseUrl}/{{tenantId}}/oauth2/v2.0/token`, type: 'string' },
      { key: 'clientId', value: '{{clientId}}', type: 'string' },
      { key: 'clientSecret', value: '{{clientSecret}}', type: 'string' },
      { key: 'scope', value: 'api://x/.default', type: 'string' },
      { key: 'addTokenTo', value: 'header', type: 'string' },
    ],
  },
  variable: [
    { key: 'baseUrl', value: baseUrl },
    { key: 'tenantId', value: 'tenant' },
    { key: 'clientId', value: 'cid' },
    { key: 'clientSecret', value: secret },
  ],
  item: [
    {
      name: 'Sales',
      item: [
        {
          name: 'Create sales order',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: {
              mode: 'raw',
              raw: '{\n  "dataAreaId": "usmf",\n  "OrderingCustomerAccountNumber": "US-001",\n  "Lines": 2,\n  "Ref": "{{orderRef}}"\n}',
              options: { raw: { language: 'json' } },
            },
            url: { raw: '{{baseUrl}}/data/SalesOrderHeadersV2', host: ['{{baseUrl}}'], path: ['data', 'SalesOrderHeadersV2'] },
          },
        },
      ],
    },
    {
      name: 'Read customer',
      request: {
        method: 'GET',
        url: {
          raw: '{{baseUrl}}/data/Customers/:account?$top=1',
          query: [{ key: '$top', value: '1' }],
          variable: [{ key: 'account', value: '' }],
        },
      },
    },
  ],
});

before(async () => {
  await initDb();
  app = createApp({ clientDist: '/nonexistent' });
  up = await startUpstream();
});
after(async () => {
  await up.close();
  await closeDb();
});

test('Postman collection: sign-in, variables and forms come from the file', () => {
  const plan = buildPostmanPlan(collection('https://h.example'));
  assert.equal(plan.moduleName, 'F&O OData - Customer and Sales order');
  assert.deepEqual(plan.auth, {
    type: 'oauth2_client_credentials',
    tokenUrl: 'https://h.example/{{tenantId}}/oauth2/v2.0/token',
    clientId: '{{clientId}}',
    clientSecret: '{{clientSecret}}',
    scope: 'api://x/.default',
  });
  assert.equal(plan.authSource, 'collection');
  assert.deepEqual(plan.variables.sort(), ['baseUrl', 'clientId', 'clientSecret', 'tenantId'].sort());
  assert.equal(plan.variableValues.clientId, 'cid');

  const so = plan.requests[0].definition;
  assert.equal(so.name, 'Create sales order');
  assert.equal(so.api.url, '{{baseUrl}}/data/SalesOrderHeadersV2');
  assert.equal(so.api.headers, undefined, 'Content-Type is not copied');
  assert.equal(so.formSchema.properties.dataAreaId.default, 'usmf', 'sample values become defaults');
  assert.equal(so.formSchema.properties.Lines.type, 'integer');
  assert.equal(so.formSchema.properties.Ref.default, undefined, '{{variables}} are not defaults');

  const read = plan.requests[1].definition;
  assert.equal(read.api.url, '{{baseUrl}}/data/Customers/{{form.account}}');
  assert.deepEqual(read.api.query, { $top: '1' });
  assert.deepEqual(read.formSchema.required, ['account']);
});

test('a "Get token" request becomes the sign-in when the collection has none', () => {
  const c = collection('https://h.example');
  delete c.auth;
  c.item.unshift({
    name: 'Get Token',
    request: {
      method: 'POST',
      body: {
        mode: 'urlencoded',
        urlencoded: [
          { key: 'grant_type', value: 'client_credentials' },
          { key: 'client_id', value: '{{clientId}}' },
          { key: 'client_secret', value: '{{clientSecret}}' },
          { key: 'scope', value: '{{baseUrl}}/.default' },
        ],
      },
      url: { raw: 'https://login.microsoftonline.com/{{tenantId}}/oauth2/v2.0/token' },
    },
  });
  const plan = buildPostmanPlan(c);
  assert.equal(plan.requests.length, 2, 'token request is not a form');
  assert.equal(plan.auth.tokenUrl, 'https://login.microsoftonline.com/{{tenantId}}/oauth2/v2.0/token');
  assert.equal(plan.auth.scope, '{{baseUrl}}/.default');
  assert.equal(plan.authSource, 'request "Get Token"');
});

test('import a Postman export, add the secret once, run a form', async () => {
  const content = JSON.stringify(collection(up.url), null, 2);
  const preview = (await request(app).post('/api/import/openapi').send({ content }).expect(200)).body;
  assert.equal(preview.format, 'postman');
  assert.equal(preview.requests.length, 2);
  assert.deepEqual(preview.problems, []);
  assert.ok(preview.auth.filled.includes('clientId'));
  assert.ok(preview.variablesWithValue.includes('tenantId'));
  assert.ok(!preview.variablesWithValue.includes('clientSecret'));

  const done = (await request(app).post('/api/import/openapi').send({ content, commit: true, fileName: 'c.json' }).expect(201)).body;
  const mod = done.module;
  assert.equal(mod.auth.type, 'oauth2_client_credentials');
  assert.equal(mod.variables.tenantId, 'tenant');
  assert.equal(mod.variables.clientId, 'cid');

  // the export had no secret: fill it in once on the module
  await request(app)
    .put(`/api/modules/${mod.id}`)
    .send({ ...mod, variables: { ...mod.variables, clientSecret: 'good' } })
    .expect(200);
  const t = (await request(app).post(`/api/modules/${mod.id}/test-auth`).expect(200)).body;
  assert.equal(t.ok, true, JSON.stringify(t));

  clearTokenCache();
  const so = done.created.find((f) => f.name === 'Create sales order');
  const run = (
    await request(app)
      .post(`/api/forms/${so.id}/execute`)
      .send({ formData: { dataAreaId: 'usmf', OrderingCustomerAccountNumber: 'US-2', Lines: 2 } })
      .expect(200)
  ).body;
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.deepEqual(up.state.lastBody, { dataAreaId: 'usmf', OrderingCustomerAccountNumber: 'US-2', Lines: 2 });

  // re-import keeps what was set on the module, and updates the forms
  const again = (await request(app).post('/api/import/openapi').send({ content, commit: true }).expect(201)).body;
  assert.equal(again.updated.length, 2);
  const after = (await request(app).get(`/api/modules/${mod.id}`)).body;
  assert.equal(after.variables.clientSecret, '••••••••');
});

test('re-import fills only empty sign-in fields of an existing module', async () => {
  const content = JSON.stringify({ ...collection(up.url), info: { ...collection(up.url).info, name: 'Partly set' } });
  await request(app)
    .post('/api/modules')
    .send({ name: 'Partly set', auth: { type: 'oauth2_client_credentials', tokenUrl: 'https://keep.example/token', clientId: 'mine', clientSecret: 's' } })
    .expect(201);
  const done = (await request(app).post('/api/import/openapi').send({ content, commit: true }).expect(201)).body;
  assert.equal(done.module.auth.tokenUrl, 'https://keep.example/token', 'existing value kept');
  assert.equal(done.module.auth.clientId, 'mine');
  assert.equal(done.module.auth.scope, 'api://x/.default', 'empty field filled from the file');
});

test('incomplete or wrong sign-in gives a clear message', async () => {
  const content = JSON.stringify({ ...collection(up.url), info: { ...collection(up.url).info, name: 'Sign-in errors' } });
  const done = (await request(app).post('/api/import/openapi').send({ content, commit: true }).expect(201)).body;
  const mod = done.module;

  // the variable for the secret is empty
  let t = (await request(app).post(`/api/modules/${mod.id}/test-auth`).expect(200)).body;
  assert.equal(t.ok, false);
  assert.match(t.message, /clientSecret/);

  // the secret is wrong
  await request(app)
    .put(`/api/modules/${mod.id}`)
    .send({ ...mod, variables: { ...mod.variables, clientSecret: 'wrong' } })
    .expect(200);
  clearTokenCache();
  t = (await request(app).post(`/api/modules/${mod.id}/test-auth`).expect(200)).body;
  assert.equal(t.ok, false);
  assert.equal(t.stage, 'auth');
  assert.match(t.message, /^Sign-in failed: The client secret is wrong/);
  assert.ok(t.details.includes('Error code: AADSTS7000215'));
});

test('the imported file is shown with its secrets hidden, and editing it keeps them', async () => {
  const base = collection(up.url, { secret: 'file-secret-123' });
  const content = JSON.stringify({ ...base, info: { ...base.info, name: 'Hidden file secrets' } }, null, 2);
  const done = (await request(app).post('/api/import/openapi').send({ content, commit: true, fileName: 'h.json' }).expect(201)).body;
  const mod = done.module;

  const shown = (await request(app).get(`/api/modules/${mod.id}/spec`).expect(200)).body;
  assert.ok(!shown.content.includes('file-secret-123'), 'secret is not sent to the browser');
  assert.ok(shown.content.includes('••••••••'));

  // admin edits the shown file (adds a field) and imports it again: preview and commit both work
  const edited = shown.content.replace('\\"Lines\\": 2', '\\"Lines\\": 2,\\n  \\"Note\\": \\"x\\"');
  assert.notEqual(edited, shown.content);
  await request(app).post('/api/import/openapi').send({ content: edited, moduleName: mod.name }).expect(200);
  await request(app).post('/api/import/openapi').send({ content: edited, moduleName: mod.name, commit: true }).expect(201);

  const { getModuleSpec } = await import('../src/repositories/modules.js');
  const stored = await getModuleSpec(mod.id);
  assert.ok(stored.content.includes('file-secret-123'), 'the real secret is still stored');
  assert.ok(stored.content.includes('Note'), 'the edit is stored');
  assert.ok(!stored.content.includes('••••••••'));

  // a marker in a file that has no stored value is refused with a clear message
  const other = JSON.stringify({ ...base, info: { ...base.info, name: 'No stored file' }, variable: [{ key: 'clientSecret', value: '••••••••' }] });
  const r = await request(app).post('/api/import/openapi').send({ content: other, commit: true }).expect(400);
  assert.match(r.body.message, /hidden value/);
});

test('a body with lists (invoices with line items) is prefilled from the sample and sent as lists', async () => {
  const sample = {
    req: [
      {
        docNo: 'INV-1',
        irnDate: null,
        lineItemAmt: 57239.83,
        supCode: '{{supplier}}',
        lineItems: [
          { lineNo: 1, itemDesc: 'Bank charges', taxableVal: 48508.33, paymentDate: null },
          { lineNo: 2, itemDesc: 'Fees', taxableVal: 10 },
        ],
      },
    ],
  };
  const col = {
    info: { name: 'Lists', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Save invoices', request: { method: 'POST', url: 'https://api.example.com/gst/save', body: { mode: 'raw', raw: JSON.stringify(sample) } } }],
  };
  const { buildPostmanPlan } = await import('../src/services/postman.js');
  const schema = buildPostmanPlan(col).requests[0].definition.formSchema;
  const req = schema.properties.req;
  assert.equal(req.type, 'array');
  assert.equal(req.items.properties.lineItems.type, 'array');
  assert.deepEqual(req.default, [
    {
      docNo: 'INV-1',
      lineItemAmt: 57239.83,
      lineItems: [
        { lineNo: 1, itemDesc: 'Bank charges', taxableVal: 48508.33 },
        { lineNo: 2, itemDesc: 'Fees', taxableVal: 10 },
      ],
    },
  ]);
});

test('blank sample fields ("" and null) are sent the way the sample sends them', async () => {
  const sample = { req: [{ docNo: 'INV-1', irn: '', irnDate: null, lineItems: [{ lineNo: 1, itemCode: '', paymentDate: null }] }], note: '' };
  const col = {
    info: { name: 'Blank fields', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Save', request: { method: 'POST', url: `${up.url}/echo`, body: { mode: 'raw', raw: JSON.stringify(sample) } } }],
  };
  const done = (await request(app).post('/api/import/openapi').send({ content: JSON.stringify(col), commit: true }).expect(201)).body;
  const form = (await request(app).get(`/api/forms/${done.created[0].id}`).expect(200)).body;
  assert.equal(form.api.sendEmptyFields, true);
  assert.deepEqual(form.api.emptyFields, { req: [{ irn: '', irnDate: null, lineItems: [{ itemCode: '', paymentDate: null }] }], note: '' });

  // the form sends what RJSF gives: blank fields left out; a second row added by the user
  const formData = { req: [{ docNo: 'INV-1', lineItems: [{ lineNo: 1 }, { lineNo: 2, itemCode: 'X' }] }] };
  await request(app).post(`/api/forms/${form.id}/execute`).send({ formData }).expect(200);
  assert.deepEqual(up.state.lastBody, {
    req: [{ docNo: 'INV-1', irn: '', irnDate: null, lineItems: [{ lineNo: 1, itemCode: '', paymentDate: null }, { lineNo: 2, itemCode: 'X', paymentDate: null }] }],
    note: '',
  });

  // switched off: blank fields are left out, as before
  await request(app).put(`/api/forms/${form.id}`).send({ ...form, api: { ...form.api, sendEmptyFields: false } }).expect(200);
  await request(app).post(`/api/forms/${form.id}/execute`).send({ formData }).expect(200);
  assert.deepEqual(up.state.lastBody, { req: [{ docNo: 'INV-1', lineItems: [{ lineNo: 1 }, { lineNo: 2, itemCode: 'X' }] }] });
});
