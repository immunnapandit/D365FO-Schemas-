# Host on Azure Web App (App Service) with GitHub Actions

This is the hosting plan agreed for Schema Forms: one Azure Web App runs the Node server, which also serves the
built React app. App Service Authentication signs users in with their Microsoft (Entra ID) account, and GitHub Actions
builds, tests and deploys on every push to `main`.

```
Browser ──► Web App (App Service Authentication: Microsoft sign-in)
               └─ Node 22: server/src/index.js  ── serves client/dist (React)
                    ├─ Cosmos DB  (modules, forms, formVersions, executions)
                    └─ D365 F&O / other APIs  (token per module, client credentials)
GitHub (push to main) ──► GitHub Actions: lint, test, build, zip ──► Web App
```

Why not a static website: the app has a backend (it gets tokens, calls the APIs, keeps secrets and history), so it
needs a Web App. A static site could only host the React part.

The other guide, [deployment.md](deployment.md), describes Container Apps with Azure DevOps. Both work with the same
code; this one is the plan for now.

---

## What to agree on first

| Item | Example |
|---|---|
| Subscription and resource group | `rg-schema-forms-dev` |
| Region | the region of the Cosmos DB account (`cosmos-nosql-db-01`) |
| Web App name (becomes `<name>.azurewebsites.net`) | `schema-forms-dev` |
| Plan size | Basic B1 to start (Always On is needed; Free/Shared do not have it) |
| Database | a **new** database for the hosted app, e.g. `integration-react-dashboard-prod`, with the same four containers |
| Admins | Ram, Harnoor, Munna |
| GitHub repository | the repo Ram shares; deploys from `main` |

Use a new database for the hosted app. Secrets in the database are encrypted with `SECRET_ENCRYPTION_KEY`, and the
hosted app gets its own key, so data saved by a laptop cannot be read there. Re-import the collections in the hosted
app and enter the module secrets again.

---

## 1. Create the Web App

Azure portal > **App Services** > **Create** > **Web App**:

- Publish: **Code**
- Runtime stack: **Node 22 LTS**
- Operating system: **Linux**
- Region: same as Cosmos DB
- Pricing plan: **Basic B1** (or larger)

After it is created, in the Web App:

1. **Settings > Configuration > General settings**
   - Startup command: `node server/src/index.js`
   - Always on: **On**
   - HTTPS only: **On**, minimum TLS: **1.2**
   - SCM / FTP basic auth publishing: **Off** (GitHub Actions signs in without a password)
2. **Settings > Identity > System assigned: On** (the app uses it for Cosmos DB and Key Vault, no keys in settings).
3. **Monitoring > Health check**: path `/health/ready`.

## 2. Give the Web App access to Cosmos DB (no key)

The app signs in to Cosmos DB with the Web App's identity when `COSMOS_KEY` is not set. Cosmos DB data access roles
are assigned with the Azure CLI (Cloud Shell works):

```bash
# the Web App's identity
principal=$(az webapp identity show -g <rg> -n <webapp> --query principalId -o tsv)

# "Cosmos DB Built-in Data Contributor" on the app's database only
az cosmosdb sql role assignment create \
  --account-name cosmos-nosql-db-01 -g <cosmos-rg> \
  --role-definition-id 00000000-0000-0000-0000-000000000002 \
  --principal-id "$principal" \
  --scope "/dbs/integration-react-dashboard-prod"
```

With an identity the app does not create containers, so create them first (Data Explorer):

| Container | Partition key | Note |
|---|---|---|
| `modules` | `/id` | |
| `forms` | `/id` | |
| `formVersions` | `/formId` | |
| `executions` | `/formId` | Time to live: On (no default) |

If the Cosmos DB account has a firewall, allow the Web App's outbound IP addresses (Web App > Networking).

## 3. App settings

Web App > **Settings > Environment variables > App settings**:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` (the package already contains everything) |
| `DB_CLIENT` | `cosmos` |
| `COSMOS_ENDPOINT` | `https://cosmos-nosql-db-01.documents.azure.com:443/` |
| `COSMOS_DATABASE` | `integration-react-dashboard-prod` |
| `AUTH_MODE` | `easyauth` |
| `AUTH_REQUIRE_ROLE` | `true` |
| `SECRET_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Best as a Key Vault reference: `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/schema-forms-key/)` |
| `ALLOWED_HOSTS` | `login.microsoftonline.com,*.dynamics.com` plus any other API host the forms call |
| `REQUEST_TIMEOUT_MS` | `180000` (the first F&O call can be slow) |
| `HISTORY_RETENTION_DAYS` | `90` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | optional, for logs and errors |

Do not set `PORT`; App Service sets it. Keep `SECRET_ENCRYPTION_KEY` safe: without it the stored secrets cannot be
read. To change it later see "Key rotation" in [deployment.md](deployment.md).

## 4. Sign-in for users (App Service Authentication)

This is the interactive Microsoft sign-in (OpenID Connect, authorization code flow). App Service does it before any
request reaches the app; the app only reads who the user is and their role. Nothing extra is coded for it.

Web App > **Settings > Authentication > Add identity provider**:

- Identity provider: **Microsoft**
- Tenant type: **Workforce configuration (current tenant)**
- App registration: **Create new**, name `schema-forms`
- Supported account types: **Current tenant - single tenant**
- Restrict access: **Require authentication**
- Unauthenticated requests: **HTTP 302 Found redirect**
- Token store: **On**

Let the health check through without sign-in (Cloud Shell):

```bash
az resource update \
  --ids /subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.Web/sites/<webapp>/config/authsettingsV2 \
  --set properties.globalValidation.excludedPaths='["/health/live","/health/ready"]'
```

### Who is admin and who is a user

The app has two roles:

- **SchemaForms.Admin**: imports collections, edits modules (sign-in, variables), edits forms.
- **SchemaForms.User**: opens and submits forms, sees history.

Signed-in people without a role see "Your account has no access to this app".

1. Entra ID > **App registrations** > `schema-forms` > **App roles** > Create app role, twice:

   | Display name | Allowed member types | Value |
   |---|---|---|
   | Schema Forms Admin | Users/Groups | `SchemaForms.Admin` |
   | Schema Forms User | Users/Groups | `SchemaForms.User` |

2. Entra ID > **Enterprise applications** > `schema-forms`:
   - **Properties** > Assignment required: **Yes** (only assigned people can sign in)
   - **Users and groups** > Add user/group: give each person one role (groups need Entra ID P1)

A role change applies after the person signs out (top-right menu) and signs in again.

## 5. GitHub Actions

The workflow is in [.github/workflows/deploy-web-app.yml](../.github/workflows/deploy-web-app.yml). On every push to
`main` it installs, runs lint, type check, tests and build, packages the server with production dependencies and the
built React app, deploys the zip, and waits for `/health/ready`.

It signs in to Azure with OpenID Connect, so no password is stored in GitHub:

1. Entra ID > **App registrations** > New registration `schema-forms-github-deploy`.
2. In it: **Certificates & secrets > Federated credentials > Add**
   - Scenario: **GitHub Actions deploying Azure resources**
   - Organization / Repository: the repo
   - Entity type: **Environment**, name `production`
3. Web App > **Access control (IAM)** > Add role assignment: **Website Contributor** to `schema-forms-github-deploy`.
4. GitHub repo > **Settings**:
   - **Environments** > New environment `production` (optionally add required reviewers to approve each deploy)
   - **Secrets and variables > Actions**
     - Secrets: `AZURE_CLIENT_ID` (of `schema-forms-github-deploy`), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
     - Variable: `AZURE_WEBAPP_NAME`
5. Merge the work to `main`, or run the workflow by hand (Actions > Deploy to Azure Web App > Run workflow).

## 6. First check after the deploy

1. Open `https://<webapp>.azurewebsites.net`: the Microsoft sign-in opens, then the app.
2. Bottom-left shows your name and **Administrator**.
3. Import the Postman collection, fill the module sign-in, **Test authentication**, submit a form.
4. Sign in as a person with the User role: forms work, Import and module settings are not shown.

If the app does not start: Web App > **Log stream**. Missing or wrong settings are listed there at start-up
(for example "SECRET_ENCRYPTION_KEY is required in production").
