import { randomUUID } from 'node:crypto';
import { getDb } from '../db/knex.js';
import { config } from '../config.js';

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
  const row = {
    id: randomUUID(),
    form_id: form.id,
    form_name: form.name,
    form_version: form.version,
    workspace_id: form.workspaceId ?? null,
    user_id: user?.id ?? null,
    user_name: user?.name ?? null,
    ok: !!result.ok,
    stage: result.stage ?? null,
    http_status: result.status ?? null,
    message: result.message?.slice(0, 4000) ?? null,
    details: result.details?.length ? JSON.stringify(result.details) : null,
    duration_ms: result.durationMs ?? null,
    request_json: truncateJson(result.request),
    response_json: truncateJson(result.response),
    request_id: requestId ?? null,
    created_at: new Date().toISOString(),
  };
  await getDb()('executions').insert(row);
  return row.id;
}

function toSummary(r) {
  return {
    id: r.id,
    formId: r.form_id,
    formName: r.form_name,
    formVersion: r.form_version === null ? undefined : Number(r.form_version),
    workspaceId: r.workspace_id ?? undefined,
    userId: r.user_id,
    userName: r.user_name,
    ok: Boolean(r.ok),
    stage: r.stage ?? undefined,
    status: r.http_status === null ? undefined : Number(r.http_status),
    message: r.message,
    durationMs: r.duration_ms === null ? undefined : Number(r.duration_ms),
    requestId: r.request_id,
    createdAt: r.created_at,
  };
}

/** userId = only this user's runs; undefined = everyone's. workspaceId = runs of that workspace's forms. */
export async function listExecutions({ workspaceId, formId, userId, limit = 50, before }) {
  const q = getDb()('executions')
    .select(
      'id', 'form_id', 'form_name', 'form_version', 'user_id', 'user_name', 'ok', 'stage',
      'http_status', 'message', 'duration_ms', 'request_id', 'created_at', 'workspace_id',
    )
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  if (workspaceId !== undefined) q.where({ workspace_id: workspaceId });
  if (formId) q.where({ form_id: formId });
  if (userId) q.where({ user_id: userId });
  if (before) q.where('created_at', '<', before);
  return (await q).map(toSummary);
}

export async function getExecution(id) {
  const r = await getDb()('executions').where({ id }).first();
  if (!r) return null;
  return {
    ...toSummary(r),
    details: parse(r.details) ?? [],
    request: parse(r.request_json),
    response: parse(r.response_json),
  };
}

export async function purgeOldExecutions(days = config.history.retentionDays) {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return getDb()('executions').where('created_at', '<', cutoff).del();
}
