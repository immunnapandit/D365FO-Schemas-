import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainTokenError } from '../src/services/errors.js';

process.env.NODE_ENV = 'test';

test('wrong client secret: plain message, Microsoft text and IDs as details', () => {
  const r = explainTokenError(401, {
    error: 'invalid_client',
    error_description:
      "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID. Trace ID: 0a1b-2c Correlation ID: 9f8e-7d Timestamp: 2026-11-18 07:00:00Z",
    error_codes: [7000215],
  });
  assert.match(r.message, /^Sign-in failed: The client secret is wrong/);
  assert.equal(r.code, 'AADSTS7000215');
  assert.ok(r.details.some((d) => d.startsWith('Message from the sign-in server: AADSTS7000215: Invalid client secret')));
  assert.ok(r.details.includes('Trace ID: 0a1b-2c'));
  assert.ok(r.details.includes('Correlation ID: 9f8e-7d'));
});

test('unknown tenant, bad scope, expired secret, generic OAuth and HTTP errors', () => {
  assert.match(explainTokenError(400, { error: 'invalid_request', error_description: "AADSTS90002: Tenant 'x' not found." }).message, /tenant was not found/);
  assert.match(explainTokenError(400, { error: 'invalid_scope', error_description: 'AADSTS70011: The provided value for scope is not valid.' }).message, /must end with \/.default/);
  assert.match(explainTokenError(401, { error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys are expired.' }).message, /has expired/);
  assert.match(explainTokenError(401, { error: 'invalid_client' }).message, /client ID or client secret was rejected/);
  assert.match(explainTokenError(404, '<html>Not found</html>').message, /token URL was not found/);
  assert.match(explainTokenError(503, {}).message, /sign-in server had an error/);
  assert.equal(explainTokenError(400, { message: 'Bad thing' }).message, 'Sign-in failed: Bad thing');
});
