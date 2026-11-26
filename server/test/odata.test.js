import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildODataQuery } from '../src/services/odata.js';
import { execute } from '../src/services/executor.js';
import { startUpstream, salesOrderDefinition } from './helpers.js';

const odata = {
  company: true,
  fields: [
    { name: 'CustomerAccount', title: 'Customer account', type: 'string' },
    { name: 'CreditLimit', type: 'number' },
    { name: 'CreatedDate', type: 'date' },
    { name: 'IsBlocked', type: 'enum', enumType: 'Microsoft.Dynamics.DataEntities.NoYes', options: ['Yes', 'No'] },
  ],
};

test('filters become one $filter; values are literals of their type', () => {
  const q = buildODataQuery(odata, {
    company: 'USMF',
    filters: [
      { field: 'CustomerAccount', op: 'eq', value: "O'Neil" },
      { field: 'CreditLimit', op: 'between', value: '100', value2: 5000 },
      { field: 'CreatedDate', op: 'between', value: '2026-01-01', value2: '2026-01-31' },
      { field: 'IsBlocked', op: 'eq', value: 'No' },
    ],
    top: 50,
    orderBy: 'CustomerAccount',
    desc: true,
  });
  assert.equal(
    q.$filter,
    "dataAreaId eq 'usmf' and CustomerAccount eq 'O''Neil' and (CreditLimit ge 100 and CreditLimit le 5000) and " +
      '(CreatedDate ge 2026-01-01T00:00:00Z and CreatedDate le 2026-01-31T23:59:59Z) and ' +
      "IsBlocked eq Microsoft.Dynamics.DataEntities.NoYes'No'",
  );
  assert.equal(q['cross-company'], 'true');
  assert.equal(q.$top, '50');
  assert.equal(q.$orderby, 'CustomerAccount desc');
  assert.equal(q.$count, 'true');
});

test('contains: * wildcards on D365, contains() on other OData services', () => {
  const f = [{ field: 'CustomerAccount', op: 'contains', value: 'US*' }];
  assert.equal(buildODataQuery(odata, { filters: f }).$filter, "CustomerAccount eq '*US*'");
  assert.equal(buildODataQuery({ ...odata, dialect: 'standard' }, { filters: f }).$filter, "contains(CustomerAccount,'US*')");
  assert.equal(buildODataQuery(odata, { filters: [{ field: 'CustomerAccount', op: 'startswith', value: 'US-' }] }).$filter, "CustomerAccount eq 'US-*'");
});

test('nothing typed can change the query in another way', () => {
  assert.throws(() => buildODataQuery(odata, { filters: [{ field: 'Secret', value: 'x' }] }), /cannot be filtered/);
  assert.throws(() => buildODataQuery(odata, { filters: [{ field: 'CreditLimit', value: '1 or 1 eq 1' }] }), /not a number/);
  assert.throws(() => buildODataQuery(odata, { filters: [{ field: 'CreatedDate', value: '2026-01-01T00:00:00Z) or (1' }] }), /not a date/);
  assert.throws(() => buildODataQuery(odata, { filters: [{ field: 'IsBlocked', value: 'Maybe' }] }), /not one of/);
  assert.throws(() => buildODataQuery(odata, { filters: [{ field: 'CustomerAccount', op: 'gt', value: 'a' }] }), /cannot be used/);
  assert.throws(() => buildODataQuery(odata, { company: "usmf' or 1 eq 1" }), /not a company code/);
  assert.throws(() => buildODataQuery(odata, { orderBy: 'Name;drop' }), /cannot be used to sort/);
  assert.throws(() => buildODataQuery(odata, { top: 20000 }), /from 1 to 10000/);
  // a quote in a text value stays inside the literal
  assert.equal(buildODataQuery(odata, { filters: [{ field: 'CustomerAccount', value: "x' or dataAreaId ne 'y" }] }).$filter, "CustomerAccount eq 'x'' or dataAreaId ne ''y'");
});

let up;
before(async () => {
  up = await startUpstream();
});
after(() => up.close());

test('a list form sends the filters as an OData query', async () => {
  const form = { ...salesOrderDefinition(up.url), formSchema: { type: 'object', properties: {} } };
  form.api = { method: 'GET', url: `${up.url}/data/CustomersV3`, odata };
  const r = await execute(form, { $query: { company: 'usmf', filters: [{ field: 'CustomerAccount', op: 'startswith', value: 'US' }], top: 10 } });
  assert.equal(r.ok, true, r.message);
  assert.equal(up.state.lastQuery.$filter, "dataAreaId eq 'usmf' and CustomerAccount eq 'US*'");
  assert.equal(up.state.lastQuery['cross-company'], 'true');
  assert.match(up.state.lastUrl, /\$filter=dataAreaId%20eq%20%27usmf%27%20and/);
  assert.equal(r.response.value.length, 2);
  assert.equal(r.message, '2 records loaded.');
});

test('header + lines: header first, then each line with the new order number', async () => {
  const form = salesOrderDefinition(up.url);
  form.formSchema.properties.lines = { type: 'array', items: { type: 'object', properties: { ItemNumber: { type: 'string' }, OrderedSalesQuantity: { type: 'number' } } } };
  form.api.lines = { field: 'lines', url: `${up.url}/data/SalesOrderLines`, set: { dataAreaId: '{{form.dataAreaId}}', SalesOrderNumber: '{{response.SalesOrderNumber}}' } };
  delete form.api.bodyTemplate;
  up.state.lines.length = 0;
  const data = { dataAreaId: 'usmf', OrderingCustomerAccountNumber: 'US-001', CurrencyCode: 'USD', lines: [{ ItemNumber: 'A100', OrderedSalesQuantity: 2 }, { ItemNumber: 'B200', OrderedSalesQuantity: 1 }] };
  const r = await execute(form, data);
  assert.equal(r.ok, true, r.message);
  assert.equal(up.state.lastBody.lines, undefined, 'the header is sent without its lines');
  assert.deepEqual(up.state.lines, [
    { ItemNumber: 'A100', OrderedSalesQuantity: 2, dataAreaId: 'usmf', SalesOrderNumber: '001234' },
    { ItemNumber: 'B200', OrderedSalesQuantity: 1, dataAreaId: 'usmf', SalesOrderNumber: '001234' },
  ]);
  assert.equal(r.lines.length, 2);

  up.state.lines.length = 0;
  const bad = await execute(form, { ...data, lines: [{ ItemNumber: 'A100' }, { ItemNumber: 'BAD' }, { ItemNumber: 'C300' }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, 'api');
  assert.match(bad.message, /but line 2 of 3 failed: .*Item number BAD does not exist/);
  assert.match(bad.details.join(' '), /1 line was created before it/);
  assert.equal(up.state.lines.length, 1, 'the line after the failed one is not sent');
});
