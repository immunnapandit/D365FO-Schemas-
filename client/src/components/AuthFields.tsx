import type { AuthConfig, AuthType } from '../lib/types'
import { AUTH_OPTIONS } from '../lib/auth-options'
import { Field, JsonText, SecretHint, Text } from './inputs'


const MODULE_OPTION = {
  value: 'module' as AuthType,
  label: "Use the module's sign-in",
  hint: 'Recommended. The sign-in is set once on the module and shared by all its forms.',
}

export default function AuthFields({ value, onChange, moduleName, allowModule }: {
  value: AuthConfig
  onChange: (auth: AuthConfig) => void
  /** forms: offer "use the module's sign-in" */
  allowModule?: boolean
  moduleName?: string
}) {
  const auth = value as Record<string, unknown> & { type: AuthType }
  const set = (key: string, v: unknown) => {
    const next = { ...auth, [key]: v }
    if (v === '' || v === undefined) delete next[key]
    onChange(next as AuthConfig)
  }
  const options = allowModule ? [MODULE_OPTION, ...AUTH_OPTIONS] : AUTH_OPTIONS
  const option = options.find((o) => o.value === auth.type)
  const oauth = auth.type === 'oauth2_client_credentials' || auth.type === 'oauth2_password'

  return (
    <div className="panel-grid">
      <Field label="How the API is signed in to" wide hint={option?.hint}>
        {(id) => (
          <select id={id} className="input" value={auth.type}
            onChange={(e) => onChange({ type: e.target.value as AuthType })}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      </Field>

      {oauth && (
        <>
          <Text label="Token URL" wide mono value={auth.tokenUrl} onChange={(v) => set('tokenUrl', v)}
            placeholder="https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token" />
          <Text label={auth.type === 'oauth2_password' ? 'Client ID (optional)' : 'Client ID'} mono value={auth.clientId} onChange={(v) => set('clientId', v)} />
          <Text label={auth.type === 'oauth2_password' ? 'Client secret (optional)' : 'Client secret'} mono secret value={auth.clientSecret}
            onChange={(v) => set('clientSecret', v)} hint={<SecretHint />} />
          {auth.type === 'oauth2_password' && (
            <>
              <Text label="User name" value={auth.username} onChange={(v) => set('username', v)} />
              <Text label="Password" mono secret value={auth.password} onChange={(v) => set('password', v)} hint={<SecretHint />} />
            </>
          )}
          <Text label="Scope" wide mono value={auth.scope} onChange={(v) => set('scope', v)}
            placeholder="https://<environment>.operations.dynamics.com/.default"
            hint="For F&O: the environment URL followed by /.default" />
        </>
      )}

      {auth.type === 'basic' && (
        <>
          <Text label="User name" value={auth.username} onChange={(v) => set('username', v)} />
          <Text label="Password" mono secret value={auth.password} onChange={(v) => set('password', v)} hint={<SecretHint />} />
        </>
      )}

      {auth.type === 'bearer_static' && (
        <Text label="Token" wide mono secret value={auth.token} onChange={(v) => set('token', v)} hint={<SecretHint />} />
      )}

      {auth.type === 'api_key' && (
        <>
          <Text label="Header name" mono value={auth.headerName} onChange={(v) => set('headerName', v)} placeholder="Ocp-Apim-Subscription-Key" />
          <Text label="Header value" mono secret value={auth.value} onChange={(v) => set('value', v)} hint={<SecretHint />} />
        </>
      )}

      {auth.type === 'token_endpoint' && (
        <>
          <Text label="Login URL" wide mono value={auth.url} onChange={(v) => set('url', v)} placeholder="https://api.contoso.com/auth/login" />
          <Field label="Method">
            {(id) => (
              <select id={id} className="input" value={(auth.method as string) ?? 'POST'} onChange={(e) => set('method', e.target.value)}>
                {['POST', 'GET', 'PUT'].map((m) => <option key={m}>{m}</option>)}
              </select>
            )}
          </Field>
          <Field label="Send the body as">
            {(id) => (
              <select id={id} className="input" value={(auth.bodyType as string) ?? 'json'} onChange={(e) => set('bodyType', e.target.value)}>
                <option value="json">JSON</option>
                <option value="form">Form fields (x-www-form-urlencoded)</option>
              </select>
            )}
          </Field>
          <JsonText label="Login request body" value={auth.body} onChange={(v) => set('body', v)}
            hint={<>For example <code>{'{ "username": "svc-user", "password": "{{kv:api-password}}" }'}</code></>} />
          <Text label="Where the token is in the response" mono value={auth.tokenPath} onChange={(v) => set('tokenPath', v)}
            placeholder="access_token" hint="Use dots for nested values, for example data.token" />
          <Text label="Where the lifetime (seconds) is" mono value={auth.expiresInPath} onChange={(v) => set('expiresInPath', v)} placeholder="expires_in" />
          <Text label="Header the token is sent in" mono value={auth.headerName} onChange={(v) => set('headerName', v)} placeholder="Authorization" />
          <Text label="Text before the token" mono value={auth.prefix} onChange={(v) => set('prefix', v)} placeholder="Bearer " />
        </>
      )}

      {auth.type === 'none' && <p className="muted field-wide">Requests are sent without credentials.</p>}

      {auth.type === 'module' && (
        <p className="muted field-wide">
          {moduleName
            ? <>Signs in with the settings of the module <strong>{moduleName}</strong>. Set them up once by clicking the module name in the sidebar.</>
            : <>Choose a module on the Details tab. Its sign-in is set up once for all its forms.</>}
        </p>
      )}
    </div>
  )
}

