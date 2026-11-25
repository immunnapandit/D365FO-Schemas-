import { randomUUID } from 'node:crypto';
import { cosmosContainer } from '../db/cosmos.js';
import { config } from '../config.js';

/**
 * Submission history in Azure Cosmos DB (container "executions", partition key /formId).
 * Same functions and return shapes as sql-executions.js.
 * Old history is removed by Cosmos itself: every document carries a ttl (HISTORY_RETENTION_DAYS).
 */

const executions = () => cosmosContainer('executions');

const parse = (s) => {
  if (s === null || s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

function truncateJson(value) {
  if (value === undefined || !config.history.storePayloads) return null;
  const s = JSON.stringify(value);
  if (s === undefined) return null;
  const max = config.history.maxPayloadBytes;
  if (Buffer.byteLength(s) <= max) return s;
  return JSON.stringify({ truncated: true, preview: s.slice(0, max) });
}

export async function recordExecution({ form, user, result, requestId }) {
  const days = config.history.retentionDays;
  const doc = {
    id: randomUUID(),
    formId: form.id,
    formName: form.name,
    formVersion: form.version,
    workspaceId: form.workspaceId ?? null,
    userId: user?.id ?? null,
    userName: user?.name ?? null,
    ok: !!result.ok,
    stage: result.stage ?? null,
    httpStatus: result.status ?? null,
    message: result.message?.slice(0, 4000) ?? null,
    details: result.details?.length ? result.details : null,
    durationMs: result.durationMs ?? null,
    request: truncateJson(result.request),
    response: truncateJson(result.response),
    requestId: requestId ?? null,
    createdAt: new Date().toISOString(),
    ...(days > 0 ? { ttl: days * 86_400 } : {}),
  };
  await executions().items.create(doc);
  return doc.id;
}

function toSummary(r) {
  return {
    id: r.id,
    formId: r.formId,
    formName: r.formName,
    formVersion: r.formVersion ?? undefined,
    workspaceId: r.workspaceId ?? undefined,
    userId: r.userId,
    userName: r.userName,
    ok: Boolean(r.ok),
    stage: r.stage ?? undefined,
    status: r.httpStatus ?? undefined,
    message: r.message,
    durationMs: r.durationMs ?? undefined,
    requestId: r.requestId,
    createdAt: r.createdAt,
  };
}

const SUMMARY_FIELDS =
  'c.id, c.formId, c.formName, c.formVersion, c.workspaceId, c.userId, c.userName, c.ok, c.stage, c.httpStatus, c.message, c.durationMs, c.requestId, c.createdAt';

/** userId = only this user's runs; undefined = everyone's. workspaceId = runs of that workspace's forms. */
export async function listExecutions({ workspaceId, formId, userId, limit = 50, before }) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const where = [];
  const parameters = [{ name: '@take', value: take }];
  if (workspaceId !== undefined) {
    where.push('c.workspaceId = @ws');
    parameters.push({ name: '@ws', value: workspaceId });
  }
  if (formId) {
    where.push('c.formId = @formId');
    parameters.push({ name: '@formId', value: formId });
  }
  if (userId) {
    where.push('c.userId = @userId');
    parameters.push({ name: '@userId', value: userId });
  }
  if (before) {
    where.push('c.createdAt < @before');
    parameters.push({ name: '@before', value: before });
  }
  const query = `SELECT ${SUMMARY_FIELDS} FROM c${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY c.createdAt DESC OFFSET 0 LIMIT @take`;
  const { resources } = await executions()
    .items.query({ query, parameters }, formId ? { partitionKey: formId } : {})
    .fetchAll();
  return resources.map(toSummary);
}

export async function getExecution(id) {
  const { resources } = await executions()
    .items.query({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
    .fetchAll();
  const r = resources[0];
  if (!r) return null;
  return { ...toSummary(r), details: r.details ?? [], request: parse(r.request), response: parse(r.response) };
}

/** Cosmos removes old documents itself (ttl), so there is nothing to purge. */
export async function purgeOldExecutions() {
  return 0;
}
