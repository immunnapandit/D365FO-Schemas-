import type { RJSFSchema, UiSchema } from '@rjsf/utils'

export interface CurrentUser {
  id: string
  name: string
  username: string
  roles: string[]
  isAdmin: boolean
}

export interface FormSummary {
  id: string
  name: string
  description?: string
  icon?: string
  category?: string
  allowedRoles?: string[]
  version?: number
  updatedAt?: string
  updatedBy?: string
}

export type AuthType =
  | 'module'
  | 'none'
  | 'basic'
  | 'bearer_static'
  | 'api_key'
  | 'oauth2_client_credentials'
  | 'oauth2_password'
  | 'token_endpoint'

export interface AuthConfig {
  type: AuthType
  [key: string]: unknown
}

export interface ApiConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url?: string
  headers?: Record<string, string>
  query?: Record<string, string>
  bodyType?: 'json' | 'form'
  bodyTemplate?: unknown
  successMessage?: string
  timeoutMs?: number
}

export interface ModuleDefinition {
  id?: string
  version?: number
  name: string
  description?: string
  auth: AuthConfig
  variables?: Record<string, string>
  headers?: Record<string, string>
  createdAt?: string
  createdBy?: string | null
  updatedAt?: string
  updatedBy?: string | null
}

export interface ImportPreview {
  moduleName: string
  moduleExists: boolean
  auth: { type: AuthType; tokenUrl?: string }
  authSource: string | null
  variables: string[]
  requests: { key: string; name: string; method: string; url: string; fieldCount: number; exists: boolean }[]
  problems: string[]
}

export interface ImportResult {
  module: ModuleDefinition
  created: { id: string; name: string }[]
  updated: { id: string; name: string }[]
}

export interface FormDefinition {
  id?: string
  version?: number
  name: string
  description?: string
  icon?: string
  category?: string
  allowedRoles?: string[]
  auth: AuthConfig
  api: ApiConfig
  source?: { format?: string; operationId?: string; method?: string; path?: string }
  formSchema: RJSFSchema
  uiSchema?: UiSchema
  createdAt?: string
  createdBy?: string | null
  updatedAt?: string
  updatedBy?: string | null
}

export type Stage = 'config' | 'validation' | 'auth' | 'api' | 'network' | 'server'

export interface ExecuteResult {
  ok: boolean
  status?: number
  stage?: Stage
  message: string
  code?: string
  details?: string[]
  request?: { method: string; url: string; body?: unknown }
  response?: unknown
  auth?: { type: string; cached?: boolean; expiresInSec?: number }
  timings?: { authMs?: number; apiMs?: number }
  durationMs?: number
  executionId?: string
  requestId?: string
}

export interface FormVersion {
  id: string
  version: number
  changeType: 'create' | 'update' | 'delete' | 'restore' | 'import'
  changedAt: string
  changedBy?: string | null
}

export interface ExecutionSummary {
  id: string
  formId: string
  formName?: string
  formVersion?: number
  userId?: string
  userName?: string
  ok: boolean
  stage?: Stage
  status?: number
  message?: string
  durationMs?: number
  requestId?: string
  createdAt: string
}

export interface ExecutionDetail extends ExecutionSummary {
  details: string[]
  request?: unknown
  response?: unknown
}
