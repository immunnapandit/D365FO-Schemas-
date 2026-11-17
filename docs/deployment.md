# Deployment guide (Azure)

The recommended setup is listed below. Steps 1–4 are one-time; after that the pipeline deploys every merge to `main`.

| piece | Azure service |
|---|---|
| app (one container: API + React) | **Azure Container Apps** (or App Service for Containers) |
| database | **Azure SQL Database** with managed identity |
| secrets | **Azure Key Vault** |
| sign-in | **Microsoft Entra ID** app registration with app roles |
| monitoring | **Application Insights** + Log Analytics |
| image | **Azure Container Registry** |

Replace the names below (`rg-schema-forms`, `sfregistry`, …) with your own.

---

## 1. Entra ID app registration (who can use the app)

One app registration is used both for the sign-in page and for the API.

1. **Entra ID → App registrations → New registration**
   - Name: `Schema Forms`, single tenant.
   - Redirect URI: platform **Single-page application (SPA)**, `https://<your-app-host>/`.
     Add `http://localhost:5173/` too if developers will use `AUTH_MODE=entra` locally.
2. **Expose an API**
   - Set the Application ID URI to `api://<client-id>`.
   - **Add a scope**: name `access_as_user`, who can consent: *Admins and users*.
3. **App roles → Create app role**, twice (allowed member types: *Users/Groups*):
   - Value `SchemaForms.Admin`: can create and edit forms and see everyone's history
   - Value `SchemaForms.User`: can submit forms
   - You can add business roles too (e.g. `Sales`) and use them in a form's `allowedRoles`.
4. **Manifest**: set `"requestedAccessTokenVersion": 2` (in older manifests: `"accessTokenAcceptedVersion": 2`).
5. **API permissions → Add → My APIs → Schema Forms → access_as_user** (delegated) → **Grant admin consent**.
6. **Enterprise applications → Schema Forms**
   - Properties: *Assignment required?* **Yes**
   - Users and groups: assign people or groups to `SchemaForms.Admin` / `SchemaForms.User`.

App settings that come from this registration:

```
AUTH_MODE=entra
AUTH_TENANT_ID=<tenant id>
AUTH_SPA_CLIENT_ID=<client id>
AUTH_API_AUDIENCE=api://<client id>,<client id>
AUTH_API_SCOPE=api://<client id>/access_as_user
```

> **Alternative: Easy Auth.** If you prefer platform authentication, turn on *Authentication* (Microsoft provider,
> "Require authentication") on the Container App / Web App and set `AUTH_MODE=easyauth`. Roles still come from the
> app roles of the registration used by Easy Auth. Use this only when platform authentication is **on**, because
> the app trusts the `X-MS-CLIENT-PRINCIPAL` header that the platform adds.

## 2. Resource group, registry, monitoring, Key Vault

```bash
az group create -n rg-schema-forms -l centralindia

az acr create -n sfregistry -g rg-schema-forms --sku Basic

az monitor log-analytics workspace create -g rg-schema-forms -n sf-logs
az monitor app-insights component create -g rg-schema-forms -a sf-insights -l centralindia \
  --workspace $(az monitor log-analytics workspace show -g rg-schema-forms -n sf-logs --query id -o tsv)

az keyvault create -n sf-vault -g rg-schema-forms --enable-rbac-authorization true
# encryption key for secrets stored in the database
az keyvault secret set --vault-name sf-vault -n secret-encryption-key --value "$(openssl rand -base64 32)"
# secrets used by your forms, referenced as {{kv:fno-client-secret}}
az keyvault secret set --vault-name sf-vault -n fno-client-secret --value "<F&O app secret>"
```

## 3. Azure SQL Database

```bash
az sql server create -n sf-sql -g rg-schema-forms -l centralindia \
  --enable-ad-only-auth --external-admin-principal-type User \
  --external-admin-name <your-upn> --external-admin-sid $(az ad signed-in-user show --query id -o tsv)
az sql db create -s sf-sql -g rg-schema-forms -n schemaforms --service-objective S0 --backup-storage-redundancy Zone
az sql server firewall-rule create -s sf-sql -g rg-schema-forms -n allow-azure --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
```

After the Container App exists (step 4), give its managed identity access. Connect to the database as the Entra
admin (Query editor in the portal) and run:

```sql
CREATE USER [schema-forms] FROM EXTERNAL PROVIDER;   -- name of the Container App
ALTER ROLE db_datareader ADD MEMBER [schema-forms];
ALTER ROLE db_datawriter ADD MEMBER [schema-forms];
ALTER ROLE db_ddladmin  ADD MEMBER [schema-forms];   -- needed for migrations on start-up
```

Tables are created and upgraded automatically when the app starts. Migrations are safe with several replicas
because they take a database lock.

## 3b. Azure Cosmos DB (instead of Azure SQL)

Use this when the team stores data in Cosmos DB. The app uses the **Cosmos DB for NoSQL** API (not the MongoDB API).
Skip step 3 if you use this.

It needs four containers. With an account key (`COSMOS_KEY`) the app creates them itself on start-up. With managed
identity it cannot (creating containers is a control-plane action), so create them once:

```bash
az cosmosdb sql database create -a <account> -g <rg> -n schemaforms
az cosmosdb sql container create -a <account> -g <rg> -d schemaforms -n modules      -p /id
az cosmosdb sql container create -a <account> -g <rg> -d schemaforms -n forms        -p /id
az cosmosdb sql container create -a <account> -g <rg> -d schemaforms -n formVersions -p /formId
az cosmosdb sql container create -a <account> -g <rg> -d schemaforms -n executions   -p /formId --ttl -1
```

`--ttl -1` turns on time-to-live without a default; each history item carries its own `ttl`
(`HISTORY_RETENTION_DAYS`), so Cosmos deletes old history by itself.

Managed identity (recommended in Azure): give the Container App's identity the data role:

```bash
az cosmosdb sql role assignment create -a <account> -g <rg> --scope "/" \
  --principal-id <container-app-principal-id> \
  --role-definition-id 00000000-0000-0000-0000-000000000002   # Cosmos DB Built-in Data Contributor
```

Settings: `DB_CLIENT=cosmos`, `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, and either `COSMOS_KEY` (store it as a Container
App secret) or nothing for managed identity. With a shared account, use a database name only this app uses.

Notes:
- Saving a form uses the document `_etag`, so two people editing the same form at once cannot overwrite each other.
- Cosmos has no transactions across containers. If writing a version history item fails, the form is still saved and
  the failure is logged.
- `npm run reencrypt` works the same way on Cosmos.

## 4. Container App

```bash
# first image (later the pipeline does this)
az acr build -r sfregistry -t schema-forms:1 .

az containerapp env create -n sf-env -g rg-schema-forms -l centralindia \
  --logs-workspace-id $(az monitor log-analytics workspace show -g rg-schema-forms -n sf-logs --query customerId -o tsv) \
  --logs-workspace-key $(az monitor log-analytics workspace get-shared-keys -g rg-schema-forms -n sf-logs --query primarySharedKey -o tsv)

az containerapp create -n schema-forms -g rg-schema-forms --environment sf-env \
  --image sfregistry.azurecr.io/schema-forms:1 \
  --registry-server sfregistry.azurecr.io --registry-identity system \
  --system-assigned \
  --ingress external --target-port 8080 \
  --min-replicas 1 --max-replicas 3 --cpu 0.5 --memory 1.0Gi
```

Grant the app's identity access to Key Vault:

```bash
PRINCIPAL=$(az containerapp show -n schema-forms -g rg-schema-forms --query identity.principalId -o tsv)
az role assignment create --assignee $PRINCIPAL --role "Key Vault Secrets User" \
  --scope $(az keyvault show -n sf-vault --query id -o tsv)
```

Then add the settings (encryption key as a Key Vault reference, never as plain text):

```bash
az containerapp secret set -n schema-forms -g rg-schema-forms --secrets \
  "enc-key=keyvaultref:https://sf-vault.vault.azure.net/secrets/secret-encryption-key,identityref:system"

az containerapp update -n schema-forms -g rg-schema-forms --set-env-vars \
  NODE_ENV=production \
  DB_CLIENT=mssql DB_HOST=sf-sql.database.windows.net DB_NAME=schemaforms DB_AUTH=managed-identity \
  AUTH_MODE=entra AUTH_TENANT_ID=<tenant> AUTH_SPA_CLIENT_ID=<client id> \
  AUTH_API_AUDIENCE="api://<client id>,<client id>" AUTH_API_SCOPE="api://<client id>/access_as_user" \
  SECRET_ENCRYPTION_KEY=secretref:enc-key \
  KEY_VAULT_URL=https://sf-vault.vault.azure.net/ \
  ALLOWED_HOSTS="login.microsoftonline.com,*.operations.dynamics.com" \
  APPLICATIONINSIGHTS_CONNECTION_STRING="$(az monitor app-insights component show -g rg-schema-forms -a sf-insights --query connectionString -o tsv)" \
  FNO_TENANT_ID=<tenant> FNO_CLIENT_ID=<F&O app client id> FNO_BASE_URL=https://<env>.operations.dynamics.com
```

**Health probes** (Container App → Containers → Health probes):
- Liveness: HTTP `GET /health/live`, port 8080
- Readiness: HTTP `GET /health/ready`, port 8080 (also checks the database)

Finally, put the app URL into the SPA redirect URI from step 1 (`https://<fqdn>/`).

> **App Service instead of Container Apps:** create a Linux Web App for Containers with the same image, set
> `WEBSITES_PORT=8080`, enable a system-assigned identity, set *Health check* to `/health/ready`, and use the same
> app settings (Key Vault references look like `@Microsoft.KeyVault(SecretUri=...)`).

## 5. D365 F&O (target system)

For every F&O environment the forms will call:

1. Register an Entra app for **service-to-service** calls (separate from the app in step 1) and create a client
   secret. Store the secret in Key Vault (`fno-client-secret`).
2. In F&O: **System administration → Setup → Microsoft Entra applications → New**: client ID, name, and a user with
   the right security roles. Without this step, every call returns 401/403.
3. Use the scope `https://<env>.operations.dynamics.com/.default` and add the host to `ALLOWED_HOSTS`.
4. In the form, click **Test connection** first, then submit.

## 6. Pipeline (Azure DevOps)

`azure-pipelines.yml` runs lint, type check, tests, the dependency audit and the build on every PR. On `main` it
builds and pushes the image, then deploys to the Container App after the approval on the
`schema-forms-prod` environment, and waits until `/health/ready` is OK.

One-time setup:
- Service connections: `sf-acr` (Docker registry → your ACR) and `sf-azure` (Azure Resource Manager, Contributor on the resource group)
- Pipelines → Environments → `schema-forms-prod` → add **Approvals**
- Edit the variables at the top of the file (`acrLoginServer`, `resourceGroup`, `containerApp`)

## Settings reference

| setting | required | default | description |
|---|---|---|---|
| `NODE_ENV` | yes | – | `production` in Azure (enables strict checks) |
| `PORT` | | 4000 (8080 in image) | listen port |
| `DB_CLIENT` | yes | sqlite (dev) | `cosmos`, `mssql`, `pg`, or `sqlite` (dev only) |
| `COSMOS_CONNECTION_STRING` | cosmos | | connection string from the portal (Keys); or use `COSMOS_ENDPOINT` + `COSMOS_KEY` |
| `COSMOS_ENDPOINT`, `COSMOS_DATABASE` | cosmos | `schemaforms` | Cosmos DB account URL and database |
| `COSMOS_KEY` | | | account key; empty = managed identity |
| `COSMOS_CREATE_CONTAINERS` | | true with key | create database/containers on start-up |
| `COSMOS_MANAGED_IDENTITY_CLIENT_ID` | | | only for a user-assigned identity |
| `DB_HOST`, `DB_NAME` | mssql | | Azure SQL server and database |
| `DB_AUTH` | | `sql` | `managed-identity` or `sql` (`DB_USER`, `DB_PASSWORD`) |
| `DB_MANAGED_IDENTITY_CLIENT_ID` | | | only for a user-assigned identity |
| `DATABASE_URL`, `DB_SSL` | pg | | PostgreSQL connection |
| `DB_POOL_MAX` | | 10 | connection pool size |
| `AUTH_MODE` | yes | none (dev) | `entra` or `easyauth` |
| `AUTH_TENANT_ID`, `AUTH_SPA_CLIENT_ID`, `AUTH_API_AUDIENCE`, `AUTH_API_SCOPE` | entra | | from step 1 |
| `AUTH_ADMIN_ROLE` / `AUTH_USER_ROLE` | | `SchemaForms.Admin` / `SchemaForms.User` | app role values |
| `AUTH_REQUIRE_ROLE` | | true | users without either role get "No access" |
| `SECRET_ENCRYPTION_KEY` | yes | | 32 bytes base64; encrypts secrets stored in the DB |
| `SECRET_ENCRYPTION_KEYS_PREVIOUS` | | | old keys while rotating (see operations.md) |
| `KEY_VAULT_URL` | for `{{kv:}}` | | e.g. `https://sf-vault.vault.azure.net/` |
| `ALLOWED_HOSTS` | yes | | comma-separated hosts the server may call; `*.domain` allowed |
| `REQUEST_TIMEOUT_MS` | | 60000 | default timeout for outbound calls |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | | | enables Application Insights |
| `LOG_LEVEL` | | info | `debug`, `info`, `warn`, `error` |
| `HISTORY_RETENTION_DAYS` | | 90 | older run history is deleted daily (0 = keep forever) |
| `HISTORY_STORE_PAYLOADS` | | true | store request/response bodies in history |
| `HISTORY_MAX_PAYLOAD_BYTES` | | 32768 | larger bodies are truncated in history |
| `RATE_LIMIT_EXECUTE_PER_MIN` | | 30 | submits per user per minute |
| `RATE_LIMIT_API_PER_MIN` | | 300 | API requests per client per minute |
| `SEED_SAMPLE_FORMS` | | true in dev, false in prod | add sample forms to an empty database |
| `TRUST_PROXY` | | true in prod | trust the Azure front end for client IPs |
| `CORS_ORIGIN` | | | only if the UI is hosted on a different domain |

The app refuses to start in production if a required setting is missing or unsafe (for example `AUTH_MODE=none`,
no encryption key, no `ALLOWED_HOSTS`, or SQLite), and it logs exactly what to fix.

## Go-live checklist

- [ ] App roles assigned; *Assignment required* = Yes
- [ ] `/health/ready` returns `{"status":"ok"}`
- [ ] Sign-in works; an account without a role sees "No access"
- [ ] Forms use `{{kv:...}}` for secrets
- [ ] **Test connection** succeeds for each F&O form
- [ ] Application Insights receives requests and `FormExecuted` events
- [ ] Pipeline approval configured on `schema-forms-prod`
- [ ] Azure SQL backup retention set to what your policy requires
