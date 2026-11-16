import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_FILE = ':memory:';
process.env.AUTH_MODE = 'easyauth';
process.env.ALLOWED_HOSTS = '127.0.0.1';

const { initDb, closeDb } = await import('../src/db/knex.js');
const { createApp } = await import('../src/app.js');

const principal = (roles, name = 'Neha') =>
  Buffer.from(
    JSON.stringify({
      auth_typ: 'aad',
      name_typ: 'name',
      role_typ: 'roles',
      claims: [
        { typ: 'name', val: name },
        { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: 'oid-neha' },
        { typ: 'preferred_username', val: 'neha@contoso.com' },
        ...roles.map((r) => ({ typ: 'roles', val: r })),
      ],
    }),
  ).toString('base64');

let app;
before(async () => {
  await initDb();
  app = createApp({ clientDist: '/nonexistent' });
});
after(closeDb);

test('reads the user and roles from X-MS-CLIENT-PRINCIPAL', async () => {
  await request(app).get('/api/me').expect(401);
  const res = await request(app).get('/api/me').set('x-ms-client-principal', principal(['SchemaForms.Admin'])).expect(200);
  assert.equal(res.body.name, 'Neha');
  assert.equal(res.body.id, 'oid-neha');
  assert.equal(res.body.isAdmin, true);
  await request(app).get('/api/me').set('x-ms-client-principal', principal([])).expect(403);
  await request(app).get('/api/me').set('x-ms-client-principal', 'not-base64-json').expect(401);
});
