/**
 * Imports: a GET on a D365 F&O entity collection (…/data/CustomersV3?$filter=…&$top=…) becomes a list form with
 * filters on screen. The fields of $filter (and $select) can be filtered, its values become the starting filters,
 * cross-company / dataAreaId become the Company box. Returns null for any other request.
 */

const ENTITY = /\/data\/[A-Za-z_][A-Za-z0-9_]*\/?$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ODATA_KEYS = ['$filter', '$top', '$select', '$orderby', '$count', '$skip', 'cross-company'];

function parseLiteral(raw) {
  const s = raw.trim();
  let m;
  if ((m = s.match(/^(?:([A-Za-z_][\w.]*))?'((?:[^']|'')*)'$/))) return { type: m[1] ? 'enum' : 'string', enumType: m[1], value: m[2].replace(/''/g, "'") };
  if ((m = s.match(/^(\d{4}-\d{2}-\d{2})(T[\d:.]+Z?)?$/))) return { type: 'date', value: m[1] };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { type: 'number', value: s };
  return null;
}

/** simple "Field op literal" parts joined by and; anything else is left out */
function parseFilter(filter) {
  const conds = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s+(eq|ne|gt|ge|lt|le)\s+((?:[A-Za-z_][\w.]*)?'(?:[^']|'')*'|[\d:.TZ-]+)/g;
  let m;
  while ((m = re.exec(filter))) {
    const lit = parseLiteral(m[3]);
    if (!lit) continue;
    let op = m[2];
    let value = lit.value;
    if (lit.type === 'string' && (op === 'eq') && value.includes('*')) {
      const core = value.replace(/^\*|\*$/g, '');
      op = value.startsWith('*') && value.endsWith('*') ? 'contains' : value.endsWith('*') ? 'startswith' : 'endswith';
      value = core;
    }
    conds.push({ field: m[1], op, value, type: lit.type, enumType: lit.enumType });
  }
  return conds;
}

/** type of a field known only by its name (from $select) */
function guessType(name) {
  if (/(Date|DateTime)$/.test(name)) return 'date';
  if (/(Quantity|Qty|Amount|Price|Limit|Percent|Percentage|Weight|Volume)$/.test(name) || /^LineNumber$/.test(name)) return 'number';
  return 'string';
}

export function d365ListFromRequest(method, urlWithoutQuery, query) {
  if (String(method).toUpperCase() !== 'GET') return null;
  const path = urlWithoutQuery.replace(/^\{\{[^}]+\}\}/, '');
  if (!ENTITY.test(path)) return null;

  const conds = query.$filter ? parseFilter(query.$filter) : [];
  const fields = new Map();
  let defaultCompany;
  const filters = [];
  for (const c of conds) {
    if (c.field === 'dataAreaId') {
      defaultCompany = c.value;
      continue;
    }
    if (!fields.has(c.field)) {
      fields.set(c.field, { name: c.field, type: c.type, ...(c.enumType ? { enumType: c.enumType } : {}) });
    }
    filters.push({ field: c.field, op: c.op, value: c.value });
  }
  const select = String(query.$select ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => NAME.test(s));
  for (const s of select) if (fields.size < 40 && !fields.has(s) && s !== 'dataAreaId') fields.set(s, { name: s, type: guessType(s) });

  const odata = { fields: [...fields.values()], company: true }; // D365 lists always offer the company box
  if (defaultCompany) odata.defaultCompany = defaultCompany;
  if (filters.length) odata.filters = filters;
  const top = Number(query.$top);
  odata.top = Number.isInteger(top) && top > 0 && top <= 10000 ? top : 100;
  if (select.length) odata.select = select;
  const order = String(query.$orderby ?? '').trim().split(/\s+/)[0];
  if (NAME.test(order)) odata.orderBy = order;

  const rest = Object.fromEntries(Object.entries(query).filter(([k]) => !ODATA_KEYS.includes(k)));
  return { odata, query: rest };
}
