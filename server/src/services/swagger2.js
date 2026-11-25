/**
 * Swagger 2.0 -> OpenAPI 3.0, enough for an import: servers, request bodies (body / formData
 * parameters), parameter schemas, definitions and security schemes. Responses are not needed.
 */
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

/** #/definitions/X -> #/components/schemas/X, everywhere in the document. */
function rewriteRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === '$ref' && typeof v === 'string'
        ? v.replace(/^#\/definitions\//, '#/components/schemas/').replace(/^#\/parameters\//, '#/components/parameters/')
        : rewriteRefs(v),
    ]),
  );
}

const SCHEMA_KEYS = ['type', 'format', 'items', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'];

/** a non-body Swagger 2 parameter keeps its schema keys on the parameter itself */
function paramSchema(p) {
  const schema = {};
  for (const k of SCHEMA_KEYS) if (p[k] !== undefined) schema[k] = p[k];
  if (schema.type === 'file') return { type: 'string', format: 'binary' };
  return Object.keys(schema).length ? schema : { type: 'string' };
}

function convertSecurity(defs) {
  const out = {};
  for (const [name, s] of Object.entries(defs ?? {})) {
    if (s?.type === 'basic') out[name] = { type: 'http', scheme: 'basic' };
    else if (s?.type === 'apiKey') out[name] = { type: 'apiKey', in: s.in, name: s.name };
    else if (s?.type === 'oauth2' && s.flow === 'application') {
      out[name] = { type: 'oauth2', flows: { clientCredentials: { tokenUrl: s.tokenUrl, scopes: s.scopes ?? {} } } };
    } else if (s?.type === 'oauth2' && s.flow === 'password') {
      out[name] = { type: 'oauth2', flows: { password: { tokenUrl: s.tokenUrl, scopes: s.scopes ?? {} } } };
    }
  }
  return out;
}

export function swagger2ToOpenApi3(input) {
  const doc = rewriteRefs(input);
  const scheme = (doc.schemes ?? []).includes('https') ? 'https' : doc.schemes?.[0] ?? 'https';
  const basePath = String(doc.basePath ?? '').replace(/\/+$/, '');
  const servers = doc.host ? [{ url: `${scheme}://${doc.host}${basePath}` }] : basePath ? [{ url: basePath }] : [];
  const globalConsumes = doc.consumes ?? ['application/json'];
  const sharedParams = doc.parameters ?? {};
  const resolveParam = (p) => (p?.$ref ? sharedParams[p.$ref.split('/').pop()] ?? p : p);

  const paths = {};
  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const item = {};
    const itemParams = (rawItem.parameters ?? []).map(resolveParam);
    for (const m of METHODS) {
      const op = rawItem[m];
      if (!op) continue;
      const params = [...itemParams, ...(op.parameters ?? []).map(resolveParam)];
      const consumes = op.consumes ?? globalConsumes;
      const out = { ...op };
      delete out.consumes;
      delete out.produces;
      out.parameters = params
        .filter((p) => p && p.in !== 'body' && p.in !== 'formData')
        .map((p) => ({
          name: p.name,
          in: p.in,
          ...(p.required ? { required: true } : {}),
          ...(p.description ? { description: p.description } : {}),
          ...(p['x-example'] !== undefined ? { example: p['x-example'] } : {}),
          schema: paramSchema(p),
        }));
      const bodyParam = params.find((p) => p?.in === 'body');
      const formParams = params.filter((p) => p?.in === 'formData');
      if (bodyParam) {
        const type = consumes.find((c) => /json/.test(c)) ?? consumes[0] ?? 'application/json';
        out.requestBody = { required: Boolean(bodyParam.required), content: { [type]: { schema: bodyParam.schema ?? {} } } };
      } else if (formParams.length) {
        const type = formParams.some((p) => p.type === 'file') || consumes.includes('multipart/form-data') ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
        const required = formParams.filter((p) => p.required).map((p) => p.name);
        out.requestBody = {
          content: {
            [type]: {
              schema: {
                type: 'object',
                properties: Object.fromEntries(formParams.map((p) => [p.name, { ...paramSchema(p), ...(p.description ? { description: p.description } : {}) }])),
                ...(required.length ? { required } : {}),
              },
            },
          },
        };
      }
      item[m] = out;
    }
    paths[path] = item;
  }

  return {
    openapi: '3.0.3',
    info: doc.info ?? { title: 'Imported API', version: '1' },
    servers,
    ...(doc.security ? { security: doc.security } : {}),
    ...(doc.tags ? { tags: doc.tags } : {}),
    paths,
    components: { schemas: doc.definitions ?? {}, securitySchemes: convertSecurity(doc.securityDefinitions) },
  };
}
