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

### Lists in a form

Every list of lines is a grid, as in D365 F&O: a row per line and a column per field, each value typed right in its
cell. Fields of an object inside a line get a column each (the object's name is shown above the field name). Wide
lists scroll sideways inside the grid, the line number and the copy / remove buttons stay in view, and the header stays
on top when the lines scroll. **Add line** adds a line at the bottom.

A list inside a line (e.g. the line items of a GST invoice) has a column with its count; the list opens as its own grid
under the line, with its own **Add line**. These open by default when the outer list has up to 10 lines; with more, the
count opens them. After a failed submit the cells with errors are marked in red and the line gets a warning sign.

Lines that are not plain records (a choice between shapes with `oneOf` / `anyOf`, free keys) are shown as cards.
To change a column width, set it on the list in uiSchema (pixels, by field path):

```json
{ "lines": { "ui:options": { "columnWidths": { "itemNumber": 220, "customer.name": 200 } } } }
```

## Error stages shown to the user

| stage | meaning |
|---|---|
| `validation` | the form data does not match `formSchema` |
| `config` | problem in the schema or server settings (missing env var / Key Vault secret, bad URL) |
| `auth` | the token request failed (wrong secret, app not registered…) |
| `network` | host unreachable, timeout, or not in `ALLOWED_HOSTS` |
| `api` | the target API returned 4xx/5xx. The F&O infolog is taken from `error.innererror`. |

## What an import fills in

- **Example values.** The example of a request body (Postman sample body, OpenAPI `example` on the media type or on the
  schema) fills the form, lists included, so a request can be sent as it was tested. Fields named like a password,
  secret, token or key are left empty.
- **Dynamic values.** `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}` and `{{$randomInt}}` in a form
  value, a URL, a query value or a header get a fresh value on every submit, as in Postman. Other `{{...}}` text typed
  in a field is sent as it is.
- **Sign-in per request.** A Postman request (or folder) whose sign-in differs from the collection's keeps its own:
  No auth, Basic, Bearer token, API key (header or query) or OAuth 2.0. Its password, token or key goes to an encrypted
  module variable (`basicPassword`, `bearerToken`, `apiKey`…) that the form refers to. In OpenAPI, `security: []` on an
  operation means no sign-in, and an `apiKey` scheme becomes a header or query value from a module variable.
- **Body values from the module.** A top-level body value that is only a collection variable (`"company": "{{company}}"`,
  with `company` defined in the collection) is not a form field: it is sent with the module's value.
- **Other bodies.** Form-urlencoded and form-data bodies are sent as a form (files are left out, with a warning).
  GraphQL bodies become `{ query, variables }`. XML and text bodies get one text box and are sent as typed with their
  `Content-Type` (`api.bodyType: "text"`). A JSON body the file does not describe gets one box to paste the JSON in
  (`"bodyTemplate": "{{form.body | json}}"`; bad JSON is reported before anything is sent).
- **Files accepted.** Postman collections v2.0 and v2.1, OpenAPI 3.0 and 3.1 (YAML or JSON) and Swagger 2.0 (converted
  on import). Without a full server address the URLs start with `{{baseUrl}}`, a module variable to fill in. References
  to other files (`$ref: other.yaml#/...`) cannot be read; the preview lists them.
- **Warnings.** The preview lists what the import could not take over (a request without a URL is skipped, a file
  upload, an XML body, a missing reference). The rest of the file is still imported.
- **Groups.** The top-level folder of a Postman request, or the first tag of an OpenAPI operation, becomes the form's
  `group`: the menu and the home page show the forms of a module under these groups.

## Workspaces

Modules, forms, imported files and run history belong to a workspace. The browser sends the chosen workspace in the
`X-Workspace-Id` header; without it the user's first workspace is used (a user without one gets "My workspace").

| API | What it does |
|---|---|
| `GET /api/workspaces` | Your workspaces. Admins add `?scope=all` to also get everyone else's (`isMine: false`, `ownerName`) |
| `POST /api/workspaces` `{ "name" }` | Creates a workspace (names are unique per person, max 60 characters) |
| `PATCH /api/workspaces/{id}` `{ "name" }` | Renames it (owner or admin) |
| `DELETE /api/workspaces/{id}` | Hides it with its forms and history (owner or admin). The last workspace of a person cannot be deleted |

A form, module or run of another workspace answers 404, so nobody learns that it exists. Module names are unique
inside a workspace, so the same collection can be imported into two workspaces with different keys and secrets.
`allowedRoles` on a form has no effect for the owner of the workspace; it is kept for sharing workspaces later.

## Modules and OpenAPI import

A **module** groups forms in the sidebar (a form's `category` is its module name) and holds what its forms share:

| Part | What it is |
|---|---|
| Sign-in (`auth`) | Same options as a form's sign-in. Forms with `"auth": { "type": "module" }` use it. |
| Variables | Values for `{{name}}` placeholders in URLs and sign-in fields, e.g. `{{tenantId}}` (like Postman collection variables). `{{var:name}}` also works. Values may use `{{env:…}}` / `{{kv:…}}`. |
| Headers | Sent with every request of the module, e.g. `Ocp-Apim-Subscription-Key`. |

Secrets in all three are stored encrypted and shown masked. Admins open a module by clicking its name in the sidebar.

### Import from OpenAPI

1. In Postman, export the collection as **OpenAPI** (YAML or JSON).
2. In the app choose **Import**, pick the file, check the preview, and import.
3. Open the module and fill in the sign-in (client ID, secret, scope) and variables once. Use **Test sign-in**.

What the import does:

- The collection (`info.title`) becomes the module. The name can be changed before importing.
- The token request (`…/oauth2/v2.0/token`, or a body with `grant_type`) is **not** a form. It becomes the module's
  OAuth 2.0 sign-in, so the backend gets the token itself before each call.
- Every other request becomes a form: method and URL from the file; path and query parameters become fields; the JSON
  request body schema becomes the form. When the body only has an example (common in Postman exports), the fields are
  built from the example. `@odata.*` and read-only properties are left out.
- API gateway keys (Azure APIM `subscription-key` query parameter or `Ocp-Apim-Subscription-Key` header) are **not**
  form fields. The value from the file is kept as a hidden, encrypted module variable (`subscriptionKey`, and
  `subscriptionKey2`, `subscriptionKey3`, … when requests use different keys) and the request sends
  `{{var:subscriptionKey}}`. Change the key once on the module page.
- Importing the same file again updates the forms with the same name (a new version each) instead of adding copies.
  The module's sign-in is kept.
- The imported file is kept (encrypted) with the module. Admins can view, download and edit it on the module page
  (**Imported file**) and update the forms from it. Secret values in the file (client secret, password, API key,
  tokens, `client_secret=` in url-encoded bodies, and the `example` of a `subscription-key` or `Authorization`
  parameter) are shown as `••••••••`; when the edited file is saved, the stored
  values are put back, so leave the marker as it is or type a new value over it. The download has the values hidden too.

### Import a Postman collection

The import also accepts a Postman collection exported with **Export collection** (v2.0 / v2.1 JSON):

- The collection's **Authorization** (OAuth 2.0 client credentials or password, basic, bearer, API key) becomes the
  module's sign-in, with the values in the file (token URL, client ID, scope…). A "Get token" request is used instead
  when the collection has no Authorization.
- **Collection variables** (`{{baseUrl}}`, `{{tenantId}}`…) become module variables, with their values. Postman exports
  initial values only, so a secret typed as a current value is not in the file: fill it in on the module.
- Each request becomes a form. The raw JSON body becomes the fields, and its sample values become default values
  (values that are `{{variables}}` stay empty). Folders are flattened. `:name` path variables become fields.
- Re-importing never overwrites a value already set on the module; it only fills empty ones.

**Lists in the body** (e.g. `"req": [ { ..., "lineItems": [ ... ] } ]`): each list becomes rows in the form, prefilled
with the sample rows. Rows can be added, removed and moved; every row is a card. Lists inside lists work too.

**Blank fields:** when the sample body has blank values (`""` or `null`), the form sends fields left empty the same way,
so the request has the same keys as the sample. This is the "Send blank fields like the imported sample" option on the
form's Request tab; turn it off to leave blank fields out (better for F&O OData, which rejects empty dates and enums).
