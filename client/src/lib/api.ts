import { authHeaders, reauthenticate } from './auth'
import { currentWorkspaceId } from './workspace'
import type {
  CurrentUser,
  ExecuteResult,
  ExecutionDetail,
  ExecutionSummary,
  FormDefinition,
  FormSummary,
  FormVersion,
  ImportPreview,
  ImportResult,
  ModuleDefinition,
  ModuleSpec,
  Workspace,
} from './types'

export class ApiError extends Error {
  status: number
  details: string[]
  code?: string
  requestId?: string
  constructor(status: number, message: string, details: string[] = [], code?: string, requestId?: string) {
    super(message)
    this.status = status
    this.details = details
    this.code = code
    this.requestId = requestId
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(await authHeaders()),
        ...(currentWorkspaceId() ? { 'X-Workspace-Id': currentWorkspaceId()! } : {}),
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your network connection and try again.')
  }
  if (res.status === 204) return undefined as T

  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    const b = (body && typeof body === 'object' ? body : {}) as {
      message?: string
      details?: string[]
      code?: string
      requestId?: string
    }
    if (res.status === 401) {
      void reauthenticate()
    }
    throw new ApiError(
      res.status,
      b.message || `Request failed (HTTP ${res.status})`,
      b.details || [],
      b.code,
      b.requestId || res.headers.get('x-request-id') || undefined,
    )
  }
  return body as T
}

const enc = encodeURIComponent
const post = (body?: unknown): RequestInit => ({ method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  me: () => request<CurrentUser>('/api/me'),
  definitionSchema: () => request<object>('/api/meta/definition-schema'),

  listWorkspaces: (everyone = false) => request<Workspace[]>(`/api/workspaces${everyone ? '?scope=all' : ''}`),
  createWorkspace: (name: string, starter?: 'd365') => request<Workspace>('/api/workspaces', post(starter ? { name, starter } : { name })),
  renameWorkspace: (id: string, name: string) =>
    request<Workspace>(`/api/workspaces/${enc(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteWorkspace: (id: string) => request<void>(`/api/workspaces/${enc(id)}`, { method: 'DELETE' }),

  listForms: () => request<FormSummary[]>('/api/forms'),
  getForm: (id: string) => request<FormDefinition>(`/api/forms/${enc(id)}`),
  createForm: (def: FormDefinition) => request<FormDefinition>('/api/forms', post(def)),
  updateForm: (id: string, def: FormDefinition) =>
    request<FormDefinition>(`/api/forms/${enc(id)}`, { method: 'PUT', body: JSON.stringify(def) }),
  deleteForm: (id: string) => request<void>(`/api/forms/${enc(id)}`, { method: 'DELETE' }),

  execute: (id: string, formData: unknown) => request<ExecuteResult>(`/api/forms/${enc(id)}/execute`, post({ formData })),
  testAuth: (id: string) => request<ExecuteResult>(`/api/forms/${enc(id)}/test-auth`, post()),

  listVersions: (id: string) => request<FormVersion[]>(`/api/forms/${enc(id)}/versions`),
  getVersion: (id: string, versionId: string) =>
    request<{ version: number; snapshot: FormDefinition }>(`/api/forms/${enc(id)}/versions/${enc(versionId)}`),

  listExecutions: (id: string, scope: 'mine' | 'all', before?: string) =>
    request<ExecutionSummary[]>(
      `/api/forms/${enc(id)}/executions?scope=${scope}&limit=50${before ? `&before=${enc(before)}` : ''}`,
    ),
  getExecution: (executionId: string) => request<ExecutionDetail>(`/api/executions/${enc(executionId)}`),

  listModules: () => request<ModuleDefinition[]>('/api/modules'),
  createModule: (m: ModuleDefinition) => request<ModuleDefinition>('/api/modules', post(m)),
  updateModule: (id: string, m: ModuleDefinition) =>
    request<ModuleDefinition>(`/api/modules/${enc(id)}`, { method: 'PUT', body: JSON.stringify(m) }),
  deleteModule: (id: string) => request<void>(`/api/modules/${enc(id)}`, { method: 'DELETE' }),
  testModuleAuth: (id: string) => request<ExecuteResult>(`/api/modules/${enc(id)}/test-auth`, post()),

  previewImport: (content: string, moduleName?: string) =>
    request<ImportPreview>('/api/import/openapi', post({ content, moduleName: moduleName || undefined })),
  runImport: (content: string, moduleName: string, include?: string[], fileName?: string) =>
    request<ImportResult>('/api/import/openapi', post({ content, moduleName, include, commit: true, fileName })),
  getModuleSpec: (id: string) => request<ModuleSpec>(`/api/modules/${enc(id)}/spec`),
}
