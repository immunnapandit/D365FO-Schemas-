# Schema definition reference

A schema definition is one JSON document per form. Admins build it in the form designer (**New form** / **Edit form**),
which has tabs for Details, Sign-in, API request and Fields. The **JSON** tab shows the same definition as text, with
autocomplete, for anything the other tabs do not cover (nested groups, lists, conditions). The server validates every save.

```jsonc
{
  "name": "F&O – Create Sales Order",           // required, shown in the sidebar
  "description": "Creates a sales order header",  // optional
  "icon": "cart",                                 // optional: document, cart, invoice, customer, vendor, product,
                                                  //           warehouse, truck, ledger, project, service, globe
  "category": "Sales and marketing",              // optional module the form is listed under
  "allowedRoles": ["Sales"],                      // optional: only users with one of these app roles see it
  "auth":  { "type": "oauth2_client_credentials", "...": "..." },
  "api":   { "method": "POST", "url": "...", "bodyTemplate": { }, "successMessage": "..." },
  "formSchema": { "type": "object", "required": [], "properties": { } },
  "uiSchema":   { }
}
```

`id`, `version`, `createdAt/By` and `updatedAt/By` are managed by the server.

## auth

| `type` | fields | use for |
|---|---|---|
| `none` | none | open APIs |
| `basic` | `username`, `password` | Basic authentication |
| `bearer_static` | `token` | a fixed token |
| `api_key` | `headerName`, `value` | e.g. `Ocp-Apim-Subscription-Key` |
| `oauth2_password` | `tokenUrl`, `username`, `password` (optional: `clientId`, `clientSecret`, `scope`, `resource`, `extraParams`) | token URL with a service account's user name and password |
| `oauth2_client_credentials` | `tokenUrl`, `clientId`, `clientSecret`, `scope` (optional: `resource`, `extraParams`) | **D365 F&O**, any Entra ID protected API |
| `token_endpoint` | `url`, `body`, `tokenPath` (optional: `method`, `bodyType`, `headers`, `expiresInPath`, `headerName`, `prefix`) | APIs with a login URL (username/password → token) |

Tokens are cached until shortly before they expire, and concurrent submits share one token request.
If the API answers **401** to a cached token, the server gets a new token and tries once more.

### D365 F&O example

```json
"auth": {
  "type": "oauth2_client_credentials",
  "tokenUrl": "https://login.microsoftonline.com/{{env:FNO_TENANT_ID}}/oauth2/v2.0/token",
  "clientId": "{{env:FNO_CLIENT_ID}}",
  "clientSecret": "{{kv:fno-client-secret}}",
  "scope": "{{env:FNO_BASE_URL}}/.default"
}
```

### Login-URL example

```json
"auth": {
  "type": "token_endpoint",
  "url": "https://api.example.com/auth/login",
  "body": { "username": "svc-user", "password": "{{kv:example-api-password}}" },
  "tokenPath": "data.accessToken",
  "expiresInPath": "data.expiresIn"
}
```

## api

| field | meaning |
|---|---|
| `method` | `GET`, `POST` (default), `PUT`, `PATCH`, `DELETE` |
| `url` | full URL; may use placeholders, e.g. `{{env:FNO_BASE_URL}}/data/SalesOrderHeadersV2` |
| `headers` | extra headers (`Authorization` from `auth` is added automatically) |
| `query` | query string, e.g. `{ "cross-company": "true" }` |
| `bodyTemplate` | shape of the request body. If you leave it out, the form data is sent as-is. |
| `bodyType` | `json` (default) or `form` |
| `successMessage` | shown on success, e.g. `"Sales order {{response.SalesOrderNumber}} created"` |
| `timeoutMs` | per-API timeout (default `REQUEST_TIMEOUT_MS`, 60 s) |

The host of every URL must be in the server's `ALLOWED_HOSTS`. Redirects are not followed.
`GET`, `PUT` and `DELETE` are retried once on 429/502/503/504 or network errors. `POST` and `PATCH` are never
retried, so they cannot create duplicate records.

### Custom service (X++) example

```json
"api": {
  "method": "POST",
  "url": "{{env:FNO_BASE_URL}}/api/services/MyServiceGroup/MyService/createSalesOrder",
  "bodyTemplate": { "_request": { "CustAccount": "{{form.custAccount}}", "Qty": "{{form.qty | number}}" } }
}
```

## Placeholders

| placeholder | value | where |
|---|---|---|
| `{{kv:secret-name}}` | secret from Azure Key Vault (`KEY_VAULT_URL`) | auth, api |
| `{{env:NAME}}` | server environment variable / app setting | auth, api |
| `{{form.field}}`, `{{form.a.b}}` | value the user entered | api |
| `{{form}}` | the whole form object | api |
| `{{response.Field}}` | value from the API response | `successMessage` only |

When a string is a single placeholder, the value keeps its type (numbers stay numbers, objects stay objects).
Fields the user left empty are removed from the body.

### Filters

`{{form.date | datetime}}`: `2026-11-20` becomes `2026-11-20T12:00:00Z`. F&O date fields need this format.

| filter | effect |
|---|---|
| `datetime` | date → ISO date-time (UTC) |
| `date` | first 10 characters (`YYYY-MM-DD`) |
| `number`, `string`, `boolean` | type conversion |
| `lower`, `upper`, `trim` | text |

Filters can be chained: `{{form.company | trim | lower}}`.

## Secrets

- **Best:** `{{kv:name}}`. The secret stays in Key Vault and is read with the app's managed identity (cached 5 min).
- `{{env:NAME}}`: from app settings (which can themselves be Key Vault references).
- **Typed directly** (e.g. `"clientSecret": "abc"`): encrypted with AES-256-GCM before it is stored, and shown as
  `••••••••` in the editor. If you leave `••••••••` unchanged when saving, the stored value is kept.
- In what users see and in the run history, secret values are replaced by `••••••••` (Key Vault values, and
  env vars whose names contain secret/password/token/key).

## formSchema and uiSchema

`formSchema` is standard **JSON Schema** (draft-07). The root must be `"type": "object"`.
The browser and the server both validate against it.

```json
"formSchema": {
  "title": "Create Sales Order",
  "type": "object",
  "required": ["dataAreaId", "customer"],
  "properties": {
    "dataAreaId": { "type": "string", "title": "Company", "default": "usmf" },
    "customer":   { "type": "string", "title": "Customer account", "minLength": 1 },
    "currency":   { "type": "string", "enum": ["USD", "INR", "EUR"], "default": "USD" },
    "qty":        { "type": "number", "minimum": 1 },
    "date":       { "type": "string", "format": "date" },
    "urgent":     { "type": "boolean", "title": "Urgent" },
    "notes":      { "type": "string", "title": "Notes" },
    "lines": {
      "type": "array", "title": "Lines",
      "items": { "type": "object", "properties": { "item": { "type": "string" }, "qty": { "type": "number" } } }
    }
  }
},
"uiSchema": {
  "customer": { "ui:placeholder": "e.g. US-001", "ui:help": "Customer account number" },
  "notes":    { "ui:widget": "textarea" },
  "ui:order": ["dataAreaId", "customer", "*"]
}
```

See the react-jsonschema-form documentation for all `uiSchema` options.

## Error stages shown to the user

| stage | meaning |
|---|---|
| `validation` | the form data does not match `formSchema` |
| `config` | problem in the schema or server settings (missing env var / Key Vault secret, bad URL) |
| `auth` | the token request failed (wrong secret, app not registered…) |
| `network` | host unreachable, timeout, or not in `ALLOWED_HOSTS` |
| `api` | the target API returned 4xx/5xx. The F&O infolog is taken from `error.innererror`. |
