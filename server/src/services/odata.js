import { StageError } from './errors.js';

/**
 * List forms on an OData entity (D365 F&O data entities): the user picks filters on screen, the server turns them into
 * $filter, $orderby, $top and cross-company. Only the fields the form lists can be filtered, and every value is
 * written as a literal of its type, so nothing typed on the form can change the query in another way.
 *
 * Form definition:  api.odata = {
 *   fields: [{ name: 'CustomerAccount', title: 'Customer account', type: 'string' | 'number' | 'date' | 'enum',
 *              enumType?: 'Microsoft.Dynamics.DataEntities.NoYes', options?: ['Yes', 'No'] }],
 *   company?: true,          // a Company box: dataAreaId eq '…' and cross-company=true
 *   top?: 100, maxTop?: 10000, select?: ['CustomerAccount', …], orderBy?: 'CustomerAccount',
 *   dialect?: 'd365' | 'standard'   // d365 (default): "contains" is written as eq '*text*'
 * }
 * Form data:  { $query: { filters: [{ field, op, value, value2? }], company?, top?, orderBy?, desc? } }
 */

export const OPS = {
  string: ['eq', 'ne', 'contains', 'startswith', 'endswith'],
  number: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between'],
  date: ['eq', 'gt', 'ge', 'lt', 'le', 'between'],
  enum: ['eq', 'ne'],
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (msg) => new StageError('validation', msg);

function stringLiteral(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function literal(field, raw, end = false) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === '' || v === undefined || v === null) throw bad(`${field.title || field.name}: enter a value.`);
  switch (field.type) {
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw bad(`${field.title || field.name}: "${v}" is not a number.`);
      return String(n);
    }
    case 'date': {
      if (!DATE.test(String(v)) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad(`${field.title || field.name}: "${v}" is not a date (YYYY-MM-DD).`);
      return `${v}T${end ? '23:59:59' : '00:00:00'}Z`;
    }
    case 'enum': {
      if (field.options?.length && !field.options.includes(String(v))) throw bad(`${field.title || field.name}: "${v}" is not one of ${field.options.join(', ')}.`);
      return field.enumType ? `${field.enumType}${stringLiteral(v)}` : stringLiteral(v);
    }
    default:
      return stringLiteral(v);
  }
}

function condition(field, op, value, value2, dialect) {
  const n = field.name;
  if (op === 'between') {
    return `(${n} ge ${literal(field, value)} and ${n} le ${literal(field, value2, true)})`;
  }
  if (field.type === 'string' && ['contains', 'startswith', 'endswith'].includes(op)) {
    const text = String(value ?? '').trim();
    if (!text) throw bad(`${field.title || n}: enter a value.`);
    if (dialect === 'd365') {
      // D365 F&O OData has no contains(): it uses * wildcards in eq
      const clean = text.replace(/\*/g, '');
      const pattern = op === 'contains' ? `*${clean}*` : op === 'startswith' ? `${clean}*` : `*${clean}`;
      return `${n} eq ${stringLiteral(pattern)}`;
    }
    return `${op}(${n},${stringLiteral(text)})`;
  }
  // a date "equals" means the whole day
  if (field.type === 'date' && op === 'eq') return `(${n} ge ${literal(field, value)} and ${n} le ${literal(field, value, true)})`;
  return `${n} ${op} ${literal(field, value, field.type === 'date' && (op === 'le' || op === 'gt'))}`;
}

/** The query string parameters for a list form, from the filters chosen on screen. */
export function buildODataQuery(odata, input = {}) {
  const fields = new Map((odata.fields ?? []).map((f) => [f.name, { type: 'string', ...f }]));
  const dialect = odata.dialect === 'standard' ? 'standard' : 'd365';
  const parts = [];
  const filters = Array.isArray(input.filters) ? input.filters : [];
  if (filters.length > 50) throw bad('Use at most 50 filters.');
  for (const f of filters) {
    if (!f || (f.value === undefined && f.value2 === undefined && !f.field)) continue;
    const field = fields.get(f.field);
    if (!field) throw bad(`"${f.field}" cannot be filtered on this form.`);
    const op = f.op || 'eq';
    if (!(OPS[field.type] ?? OPS.string).includes(op)) throw bad(`${field.title || field.name}: "${op}" cannot be used.`);
    parts.push(condition(field, op, f.value, f.value2, dialect));
  }

  const query = {};
  if (odata.company && input.company !== undefined && String(input.company).trim()) {
    const company = String(input.company).trim();
    if (!/^[A-Za-z0-9_-]{1,10}$/.test(company)) throw bad(`Company: "${company}" is not a company code.`);
    parts.unshift(`dataAreaId eq ${stringLiteral(company.toLowerCase())}`);
    query['cross-company'] = 'true';
  }
  if (parts.length) query.$filter = parts.join(' and ');

  const maxTop = Math.min(Number(odata.maxTop) || 10000, 10000);
  const top = input.top === undefined || input.top === '' ? Number(odata.top) || 100 : Number(input.top);
  if (!Number.isInteger(top) || top < 1 || top > maxTop) throw bad(`Rows: enter a number from 1 to ${maxTop}.`);
  query.$top = String(top);
  query.$count = 'true';

  const orderBy = input.orderBy || odata.orderBy;
  if (orderBy) {
    if (!NAME.test(orderBy) || !(fields.has(orderBy) || (odata.select ?? []).includes(orderBy) || orderBy === odata.orderBy)) {
      throw bad(`"${orderBy}" cannot be used to sort.`);
    }
    query.$orderby = `${orderBy}${input.desc ? ' desc' : ''}`;
  }
  if (Array.isArray(odata.select) && odata.select.length) query.$select = odata.select.filter((s) => NAME.test(s)).join(',');
  return query;
}
