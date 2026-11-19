import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSpecContent, restoreSpecContent } from '../src/services/spec-secrets.js';

const MASK = '••••••••';

const postman = `{
\t"auth": { "type": "oauth2", "oauth2": [
\t\t{ "key": "clientSecret", "value": "{{clientSecret}}", "type": "string" },
\t\t{ "key": "accessTokenUrl", "value": "https://login/token", "type": "string" } ] },
\t"variable": [
\t\t{ "key": "clientId", "value": "app-1" },
\t\t{ "key": "clientSecret", "value": "s3cr3t~value" },
\t\t{ "key": "password", "type": "string", "value": "p@ss" } ],
\t"item": [ { "request": { "body": { "mode": "urlencoded", "raw": "grant_type=client_credentials&client_secret=raw-sec&scope=x" },
\t\t"header": [ { "key": "Ocp-Apim-Subscription-Key", "value": "apim-key-1" } ] } } ]
}`;

test('Postman: literal secrets are hidden, placeholders and other values stay', () => {
  const m = maskSpecContent(postman);
  for (const s of ['s3cr3t~value', 'p@ss', 'raw-sec', 'apim-key-1']) assert.ok(!m.includes(s), `${s} is hidden`);
  assert.ok(m.includes('"{{clientSecret}}"'));
  assert.ok(m.includes('app-1') && m.includes('https://login/token'));
  assert.ok(m.includes('\t"variable"'), 'layout is kept');
  JSON.parse(m); // still valid JSON
});

test('Postman: an edited file gets its stored secrets back', () => {
  const edited = maskSpecContent(postman).replace('app-1', 'app-2');
  const { content, missing } = restoreSpecContent(edited, postman);
  assert.deepEqual(missing, []);
  assert.equal(content, postman.replace('app-1', 'app-2'));
});

test('a secret typed over the marker is kept', () => {
  const edited = maskSpecContent(postman).replace(`"value": "${MASK}" }`, '"value": "new-secret" }');
  const { content, missing } = restoreSpecContent(edited, postman);
  assert.deepEqual(missing, []);
  assert.ok(content.includes('new-secret') && !content.includes(MASK));
});

test('YAML: key: value and url-encoded examples are hidden and restored', () => {
  const yaml = `paths:\n  /token:\n    post:\n      requestBody:\n        content:\n          application/x-www-form-urlencoded:\n            example: grant_type=client_credentials&client_id=abc&client_secret=yaml-sec\n            schema:\n              properties:\n                client_secret:\n                  type: string\n          example:\n            grant_type: client_credentials\n            client_secret: "yaml-sec-2"\n            password: hunter2\n`;
  const m = maskSpecContent(yaml);
  for (const s of ['yaml-sec', 'yaml-sec-2', 'hunter2']) assert.ok(!m.match(new RegExp(`\\b${s}\\b`)), `${s} hidden`);
  assert.ok(m.includes('client_secret:\n'), 'a key without a value is untouched');
  const schema = 'properties:\n  client_secret: { type: string }\n  password: [a, b]\n';
  assert.equal(maskSpecContent(schema), schema, 'schemas are not secrets');
  const { content, missing } = restoreSpecContent(m, yaml);
  assert.deepEqual(missing, []);
  assert.equal(content, yaml);
});

test('a marker that cannot be matched is reported', () => {
  const { missing } = restoreSpecContent(`{ "password": "${MASK}" }`, '{ "other": 1 }');
  assert.deepEqual(missing, ['password']);
});
