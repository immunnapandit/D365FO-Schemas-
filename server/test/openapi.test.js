import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startUpstream } from './helpers.js';

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = ':memory:';
process.env.AUTH_MODE = 'none';
process.env.ALLOWED_HOSTS = '127.0.0.1';

const { initDb, closeDb, getDb } = await import('../src/db/knex.js');
const { createApp } = await import('../src/app.js');
const { clearTokenCache } = await import('../src/services/outbound-auth.js');
const { toFormSchema, parseSpec, buildImportPlan } = await import('../src/services/openapi.js');

let app;
let up;

/** Same shape as a Postman collection exported as OpenAPI (YAML). */
const spec = (url) => `openapi: 3.0.0
info:
  title: F&O Integration Test
  version: 1.0.0
paths:
  /%7B%7BtenantId%7D%7D/oauth2/v2.0/token:
    post:
      summary: Generate Token
      requestBody:
        $ref: '#/components/requestBodies/token'
      servers:
        - url: ${url}
  /data/SalesOrderHeadersV2:
    post:
      summary: Create sales order
      requestBody:
        content:
          application/json:
            schema:
              type: object
              example:
                dataAreaId: usmf
                OrderingCustomerAccountNumber: US-001
                "@odata.etag": W/"x"
      security:
        - bearer: []
      servers:
        - url: ${url}
  /data/Flaky:
    get:
      summary: Read flaky
      parameters:
        - name: $top
          in: query
          schema:
            type: integer
      servers:
        - url: ${url}
components:
  schemas:
    token:
      type: object
      properties:
        client_id: { type: string }
        client_secret: { type: string }
        grant_type: { type: string }
  requestBodies:
    token:
      content:
        application/x-www-form-urlencoded:
          schema:
            $ref: '#/components/schemas/token'
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
`;

before(async () => {
  await initDb();
  app = createApp({ clientDist: '/nonexistent' });
  up = await startUpstream();
});
after(async () => {
  await up.close();
  await closeDb();
});

test('OpenAPI schema is turned into a form schema', () => {
  const s = toFormSchema({
    type: 'object',
    required: ['CustomerAccount', 'RecId'],
    properties: {
      '@odata.etag': { type: 'string' },
      CustomerAccount: { type: 'string', nullable: true, maxLength: 20, example: 'US-001' },
      RecId: { type: 'integer', format: 'int64', readOnly: true },
      Created: { type: 'string', format: 'date-time' },
    },
  });
  assert.deepEqual(Object.keys(s.properties), ['CustomerAccount', 'Created']);
  assert.deepEqual(s.required, ['CustomerAccount']);
  assert.equal(s.properties.CustomerAccount.nullable, undefined);
  assert.equal(s.properties.Created.format, 'date-time');
});

test('clear messages for files that are not OpenAPI 3', () => {
  assert.throws(() => parseSpec('swagger: "2.0"\npaths: {}'), /no requests/);
  assert.throws(() => parseSpec('just: text'), /not a Postman collection .* or an OpenAPI file/);
  assert.throws(() => parseSpec('openapi: 3.0.0\n  bad: [indent'), /not valid YAML/);
});

test('token request becomes the module sign-in, not a form', () => {
  const plan = buildImportPlan(parseSpec(spec('https://x.example')));
  assert.equal(plan.auth.type, 'oauth2_client_credentials');
  assert.equal(plan.auth.tokenUrl, 'https://x.example/{{tenantId}}/oauth2/v2.0/token');
  assert.deepEqual(plan.variables, ['tenantId']);
  assert.deepEqual(plan.requests.map((r) => r.key), ['POST /data/SalesOrderHeadersV2', 'GET /data/Flaky']);
  const so = plan.requests[0].definition;
  assert.deepEqual(Object.keys(so.formSchema.properties), ['dataAreaId', 'OrderingCustomerAccountNumber']);
  assert.equal(so.api.bodyTemplate, undefined, 'form data is sent as-is');
  assert.deepEqual(plan.requests[1].definition.api.query, { $top: '{{form.$top}}' });
});

test('import: preview, commit, set up sign-in once, run, re-import', async () => {
  const content = spec(up.url);

  const preview = (await request(app).post('/api/import/openapi').send({ content }).expect(200)).body;
  assert.equal(preview.moduleName, 'F&O Integration Test');
  assert.equal(preview.moduleExists, false);
  assert.equal(preview.requests.length, 2);
  assert.deepEqual(preview.problems, []);

  const done = (await request(app).post('/api/import/openapi').send({ content, commit: true, fileName: 'fo.yaml' }).expect(201)).body;
  assert.equal(done.module.spec.fileName, 'fo.yaml');
  const stored = (await request(app).get(`/api/modules/${done.module.id}/spec`).expect(200)).body;
  assert.equal(stored.content, content);
  const raw = await getDb()('modules').where({ id: done.module.id }).first();
  assert.match(raw.spec, /^enc:v1:/, 'file is stored encrypted');
  assert.equal(done.created.length, 2);
  const mod = done.module;
  assert.deepEqual(mod.variables, { tenantId: '' });

  const list = (await request(app).get('/api/forms').expect(200)).body;
  const so = list.find((f) => f.name === 'Create sales order');
  assert.equal(so.category, 'F&O Integration Test');

  // sign-in not filled in yet -> clear message
  let run = (await request(app).post(`/api/forms/${so.id}/execute`).send({ formData: { OrderingCustomerAccountNumber: 'US-1' } })).body;
  assert.equal(run.ok, false);
  assert.equal(run.stage, 'config');

  // set up the module once (secret is stored encrypted and returned masked)
  const saved = (
    await request(app)
      .put(`/api/modules/${mod.id}`)
      .send({
        ...mod,
        auth: { ...mod.auth, clientId: 'cid', clientSecret: 'good', scope: 'api://x/.default' },
        variables: { tenantId: 'tenant' },
        headers: { 'Ocp-Apim-Subscription-Key': 'sub-key' },
      })
      .expect(200)
  ).body;
  assert.equal(saved.auth.clientSecret, '••••••••');
  assert.equal(saved.headers['Ocp-Apim-Subscription-Key'], '••••••••');

  const t = (await request(app).post(`/api/modules/${mod.id}/test-auth`).expect(200)).body;
  assert.equal(t.ok, true, JSON.stringify(t));

  clearTokenCache();
  run = (
    await request(app)
      .post(`/api/forms/${so.id}/execute`)
      .send({ formData: { dataAreaId: 'usmf', OrderingCustomerAccountNumber: 'US-1' } })
      .expect(200)
  ).body;
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.deepEqual(up.state.lastBody, { dataAreaId: 'usmf', OrderingCustomerAccountNumber: 'US-1' });
  assert.equal(up.state.lastHeaders['ocp-apim-subscription-key'], 'sub-key');
  assert.equal(run.response.SalesOrderNumber, '001234');

  // saving the module again with the masked values keeps the secrets
  const again = (await request(app).put(`/api/modules/${mod.id}`).send(saved).expect(200)).body;
  clearTokenCache();
  assert.equal((await request(app).post(`/api/modules/${mod.id}/test-auth`)).body.ok, true);

  // importing the same file again updates the forms instead of adding copies
  const re = (await request(app).post('/api/import/openapi').send({ content, commit: true }).expect(201)).body;
  assert.equal(re.created.length, 0);
  assert.equal(re.updated.length, 2);
  const after = (await request(app).get(`/api/forms/${so.id}`).expect(200)).body;
  assert.equal(after.version, 2);
  assert.equal((await request(app).get(`/api/modules/${mod.id}`)).body.version, again.version, 'module sign-in kept');

  // edit the stored YAML in the app and import it again: the form is renamed -> a new form, the old one stays
  const edited = (await request(app).get(`/api/modules/${mod.id}/spec`)).body.content.replace('summary: Read flaky', 'summary: Read flaky v2');
  const re2 = (await request(app).post('/api/import/openapi').send({ content: edited, moduleName: 'F&O Integration Test', commit: true }).expect(201)).body;
  assert.deepEqual(re2.created.map((f) => f.name), ['Read flaky v2']);
  assert.equal((await request(app).get(`/api/modules/${mod.id}/spec`)).body.content, edited);

  // a module with forms cannot be deleted
  await request(app).delete(`/api/modules/${mod.id}`).expect(409);

  // renaming the module moves its forms
  await request(app)
    .put(`/api/modules/${mod.id}`)
    .send({ ...again, name: 'Sandbox APIs' })
    .expect(200);
  const moved = (await request(app).get('/api/forms').expect(200)).body.filter((f) => f.category === 'Sandbox APIs');
  assert.equal(moved.length, 3);
});

test('module validation and name clashes', async () => {
  await request(app).post('/api/modules').send({ name: 'Basic one', auth: { type: 'basic' } }).expect(400);
  await request(app)
    .post('/api/modules')
    .send({ name: 'Basic one', auth: { type: 'basic', username: 'u', password: 'p' } })
    .expect(201);
  await request(app)
    .post('/api/modules')
    .send({ name: 'basic ONE', auth: { type: 'none' } })
    .expect(409);
});

test('a large file (over 2 MB, like a full API export) is imported, kept compressed and shown again', async () => {
  // 520 paths with long descriptions and example bodies: about 2.1 MB of YAML
  const paths = Array.from({ length: 520 }, (_, i) => `  /data/Entity${i}:
    post:
      operationId: createEntity${i}
      summary: Create entity ${i}
      description: ${'Creates a record of entity ' + i + ' with all its fields. '.repeat(30)}
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
${Array.from({ length: 40 }, (_, k) => `                field${k}: { type: string, description: Field ${k} of entity ${i} }`).join('\n')}
      responses:
        '201': { description: Created }`).join('\n');
  const content = `openapi: 3.0.0\ninfo: { title: Big API, version: '1' }\nservers:\n  - url: https://big.example.com\npaths:\n${paths}\n`;
  assert.ok(content.length > 2_000_000, `test file is ${content.length} characters`);

  const preview = (await request(app).post('/api/import/openapi').send({ content }).expect(200)).body;
  assert.equal(preview.requests.length, 520);
  const done = (await request(app).post('/api/import/openapi').send({ content, commit: true, fileName: 'big.yaml', include: [preview.requests[0].key ?? preview.requests[0].id ?? 0].filter(Boolean) }).expect(201)).body;
  const shown = (await request(app).get(`/api/modules/${done.module.id}/spec`).expect(200)).body;
  assert.equal(shown.content, content, 'the same file comes back');
  const raw = await getDb()('modules').where({ id: done.module.id }).first();
  assert.ok(raw.spec.length < 1_600_000, `stored ${raw.spec.length} characters`);
});

test('API gateway keys (APIM subscription-key) go to the module, hidden, not onto the form', async () => {
  const content = `openapi: 3.0.0
info: { title: Gateway Key Test, version: '1' }
paths:
  /echo:
    post:
      summary: Send with key
      parameters:
        - name: subscription-key
          in: query
          required: true
          schema: { type: string }
          example: k-111aaa
        - name: Authorization
          in: header
          required: true
          schema: { type: string }
          example: a55c-secret-token
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { item: { type: string } } }
      servers: [{ url: '${up.url}' }]
  /echo2:
    post:
      summary: Other product
      parameters:
        - name: Ocp-Apim-Subscription-Key
          in: header
          required: true
          schema: { type: string }
          example: k-222bbb
      servers: [{ url: '${up.url}' }]
`;
  const done = (await request(app).post('/api/import/openapi').send({ content, commit: true, fileName: 'gw.yaml' }).expect(201)).body;
  const mod = done.module;
  assert.equal(mod.variables.subscriptionKey, '••••••••', 'key is a hidden module variable');
  assert.equal(mod.variables.subscriptionKey2, '••••••••');
  const raw = await getDb()('modules').where({ id: mod.id }).first();
  assert.doesNotMatch(raw.variables ?? JSON.stringify(raw), /k-111aaa/, 'key is stored encrypted');

  const forms = (await request(app).get('/api/forms').expect(200)).body.filter((f) => f.category === 'Gateway Key Test');
  const send = forms.find((f) => f.name === 'Send with key');
  const full = (await request(app).get(`/api/forms/${send.id}`).expect(200)).body;
  assert.equal(full.formSchema.properties['subscription-key'], undefined, 'no form field for the key');
  assert.ok(!(full.formSchema.required ?? []).includes('subscription-key'));
  assert.equal(full.api.query['subscription-key'], '{{var:subscriptionKey}}');
  const other = (await request(app).get(`/api/forms/${forms.find((f) => f.name === 'Other product').id}`).expect(200)).body;
  assert.equal(other.api.headers['Ocp-Apim-Subscription-Key'], '{{var:subscriptionKey2}}');

  const run = (await request(app).post(`/api/forms/${send.id}/execute`).send({ formData: { item: 'A1' } }).expect(200)).body;
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(up.state.lastQuery['subscription-key'], 'k-111aaa', 'the key from the file is sent');
  assert.deepEqual(up.state.lastBody, { item: 'A1' });

  // the stored file is shown without the key or the Authorization token, and saves back unchanged
  const shown = (await request(app).get(`/api/modules/${mod.id}/spec`).expect(200)).body.content;
  assert.doesNotMatch(shown, /k-111aaa|k-222bbb|a55c-secret-token/);
  const again = (
    await request(app).post('/api/import/openapi').send({ content: shown, moduleName: 'Gateway Key Test', commit: true, fileName: 'gw.yaml' }).expect(201)
  ).body;
  const stored = (await request(app).get(`/api/modules/${again.module.id}/spec`).expect(200)).body.content;
  assert.equal(stored, shown);
  const modules = await import('../src/repositories/modules.js');
  const back = await modules.getModuleSpec(again.module.id);
  assert.equal(back.content, content, 'the real keys were put back from the stored file');
});

test('Swagger 2.0: body, form and path parameters, definitions and basic sign-in', () => {
  const doc = {
    swagger: '2.0', info: { title: 'Vendors', version: '1' }, host: 'api.example.com', basePath: '/api', schemes: ['https'],
    securityDefinitions: { basic: { type: 'basic' } }, security: [{ basic: [] }],
    paths: {
      '/vendors': { post: { summary: 'Create vendor', parameters: [
        { in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Vendor' } },
        { in: 'query', name: 'company', type: 'string', default: 'USMF' } ] } },
      '/vendors/{id}': { get: { summary: 'Get vendor', parameters: [{ in: 'path', name: 'id', required: true, type: 'string' }] } },
      '/notes': { post: { summary: 'Note', consumes: ['application/x-www-form-urlencoded'], parameters: [{ in: 'formData', name: 'note', type: 'string', required: true }] } },
    },
    definitions: { Vendor: { type: 'object', required: ['accountNum'], properties: { accountNum: { type: 'string' }, blocked: { type: 'boolean' } } } },
  };
  const plan = buildImportPlan(parseSpec(JSON.stringify(doc)));
  assert.equal(plan.auth.type, 'basic');
  const [create, get, note] = plan.requests.map((r) => r.definition);
  assert.equal(create.api.url, 'https://api.example.com/api/vendors');
  assert.deepEqual(Object.keys(create.formSchema.properties).sort(), ['accountNum', 'blocked', 'company']);
  assert.ok(create.formSchema.required.includes('accountNum'));
  assert.equal(get.api.url, 'https://api.example.com/api/vendors/{{form.id}}');
  assert.equal(note.api.bodyType, 'form');
  assert.deepEqual(note.formSchema.required, ['note']);
});

test('operation security: no sign-in, a gateway key, or the module sign-in', () => {
  const doc = {
    openapi: '3.0.0', info: { title: 'S', version: '1' }, servers: [{ url: 'https://x.example' }],
    security: [{ entra: [] }],
    components: { securitySchemes: {
      key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      entra: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://login/t', scopes: {} } } },
    } },
    paths: {
      '/a': { get: { summary: 'Module' } },
      '/b': { get: { summary: 'Open', security: [] } },
      '/c': { get: { summary: 'Key', security: [{ key: [] }] } },
    },
  };
  const plan = buildImportPlan(parseSpec(JSON.stringify(doc)));
  assert.equal(plan.auth.type, 'oauth2_client_credentials', 'the scheme of the top-level security, not the first defined');
  const [a, b, c] = plan.requests.map((r) => r.definition);
  assert.equal(a.auth.type, 'module');
  assert.equal(b.auth.type, 'none');
  assert.equal(c.auth.type, 'none');
  assert.equal(c.api.headers['X-Api-Key'], '{{var:keyKey}}');
  assert.ok(plan.variables.includes('keyKey'));
});

test('no server address, and references the file does not contain, are reported', () => {
  const doc = {
    openapi: '3.0.0', info: { title: 'S', version: '1' },
    paths: { '/a': { post: { summary: 'A', requestBody: { content: { 'application/json': { schema: { $ref: './other.yaml#/X' } } } } } } },
  };
  const plan = buildImportPlan(parseSpec(JSON.stringify(doc)));
  assert.equal(plan.requests[0].url, '{{baseUrl}}/a');
  assert.ok(plan.variables.includes('baseUrl'));
  assert.match(plan.warnings.join(' '), /baseUrl/);
  assert.match(plan.warnings.join(' '), /another file \(\.\/other\.yaml#\/X\)/);
});

test('XML bodies get one text box; JSON bodies without a schema get a box to paste JSON in', () => {
  const doc = {
    openapi: '3.0.0', info: { title: 'S', version: '1' }, servers: [{ url: 'https://x.example' }],
    paths: {
      '/xml': { post: { summary: 'Xml', requestBody: { content: { 'application/xml': { schema: { type: 'object' }, example: '<a/>' } } } } },
      '/loose': { post: { summary: 'Loose', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } },
    },
  };
  const [xml, loose] = buildImportPlan(parseSpec(JSON.stringify(doc))).requests.map((r) => r.definition);
  assert.equal(xml.api.bodyType, 'text');
  assert.equal(xml.api.headers['Content-Type'], 'application/xml');
  assert.equal(xml.formSchema.properties.body.default, '<a/>');
  assert.equal(loose.api.bodyTemplate, '{{form.body | json}}');
  assert.equal(loose.formSchema.properties.body.title, 'Body (JSON)');
});

test('paths that carry their own address are kept; // paths get the base address', () => {
  const doc = {
    openapi: '3.0.0', info: { title: 'S', version: '1' }, servers: [],
    paths: { '{{base_url}}/api/a': { get: { summary: 'A' } }, '//api/b': { get: { summary: 'B' } }, '/c': { get: { summary: 'C' } } },
  };
  const plan = buildImportPlan(parseSpec(JSON.stringify(doc)));
  assert.deepEqual(plan.requests.map((r) => r.url), ['{{base_url}}/api/a', '{{baseUrl}}/api/b', '{{baseUrl}}/c']);
});
