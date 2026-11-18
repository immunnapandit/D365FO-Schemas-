import { parseText, parseSpec, buildImportPlan, ImportError } from './openapi.js';
import { isPostmanCollection, buildPostmanPlan } from './postman.js';

/**
 * Import file (text) -> plan: one module + one form per request.
 * Accepts an OpenAPI 3 document (YAML or JSON) or a Postman collection (v2.0 / v2.1 JSON export).
 */
export function planFromContent(content, opts = {}) {
  const doc = parseText(content);
  if (isPostmanCollection(doc)) {
    const plan = buildPostmanPlan(doc, opts);
    if (!plan.requests.length && plan.auth.type === 'none') throw new ImportError('The collection has no requests.');
    return plan;
  }
  return { format: 'openapi', variableValues: {}, ...buildImportPlan(parseSpec(doc), opts) };
}

export { ImportError };
