# Schema Forms

Build forms from a **schema definition** and submit them straight into **D365 Finance & Operations** or any REST API.
An admin describes the authentication, the target API and the fields in JSON. The app renders the form, and when
a user clicks **Submit**, the server gets a token, calls the API and shows the result. If the call fails, the user
sees the real reason (for F&O, the infolog text).

```
 Browser (React)                     Schema Forms server (Node/Express)                 Target systems
┌──────────────────┐  Entra ID     ┌──────────────────────────────────────┐   token   ┌────────────────────┐
│ sidebar of forms │  sign-in      │ • validates the user + app role      │ ────────► │ Entra ID / login   │
│ dynamic form     │ ────────────► │ • validates form data (JSON Schema)  │           └────────────────────┘
│ result + history │ ◄──────────── │ • secrets: Key Vault / encrypted     │   call    ┌────────────────────┐
│ schema editor    │   JSON only   │ • token cache, retries, timeouts     │ ────────► │ D365 F&O OData /   │
└──────────────────┘               │ • run history, versions, audit       │           │ custom service /   │
                                   └──────────────┬───────────────────────┘           │ any REST API       │
                                                  │                                   └────────────────────┘
                                         Cosmos DB / Azure SQL / PostgreSQL
```

## Features

**Workspaces**
- Every user works in their own workspaces (for example one for Bata, one for Vista): modules, forms, imported files
  and run history are kept per workspace, and nobody else sees them
- Switch workspaces in the menu; create, rename and delete them on the Workspaces page. Links include the workspace
- Users import, build and run forms in their own workspaces. Admins can also open other people's workspaces to help
- Data from before workspaces is moved into the first admin's "My workspace" automatically

**For users**
- Forms listed in the left navigation, grouped by module (like F&O), with search and deep links (`/#/form/<id>`)
- Forms rendered from JSON Schema with inline validation
- After each submit, a three-step result (check input, sign in, call API) that shows where it failed and why,
  including the F&O infolog, plus a support reference ID
- History of your own submissions, with the request that was sent and the response

**For the owner of a workspace (and admins)**
- Form designer with tabs for details, sign-in, API request and fields, a live preview, and a JSON tab for advanced schemas
- Version history of every schema: see who changed what, load an old version, restore it
- Protection against concurrent edits: if two admins save at the same time, the second save is rejected (409) instead of overwriting the first
- **Test connection** button and a submission history for everyone who ran a form in the workspace

**Platform / security**
- Sign-in with Microsoft Entra ID (MSAL + JWT validation) or App Service Easy Auth; `SchemaForms.User` app role to use the app, `SchemaForms.Admin` to also open other people's workspaces
- Secrets are never sent to the browser. They come from **Azure Key Vault** (`{{kv:name}}`) or **AES-256-GCM encrypted** in the DB, with key rotation
- Outbound calls only to `ALLOWED_HOSTS` (SSRF protection), with timeouts, a response size limit, safe retries and token refresh on 401
- Strict security headers (no `unsafe-eval` / inline scripts), rate limiting, request IDs, structured logs with secrets redacted
- Application Insights, health probes, graceful shutdown, history retention
- Azure Cosmos DB for NoSQL, Azure SQL (both with managed identity) or PostgreSQL; SQLite only for local development
- 70 automated tests (incl. Cosmos DB emulator), lint, type check, Docker image, Azure DevOps pipeline

## Quick start (local)

You need **Node.js 22+**.

```bash
npm install          # root tools
npm run setup        # server + client dependencies
cp server/.env.example server/.env
npm run dev          # API on :4000, React on :5173 (open http://localhost:5173)
```

Locally the app uses SQLite (built into Node, nothing to install) and `AUTH_MODE=none` (you are an admin). An empty
database gets two starter forms for F&O: **Create sales order** and **Create customer**.
To use them, fill in `FNO_*` in `server/.env`. The F&O prerequisites are in
[docs/deployment.md → D365 F&O](docs/deployment.md#5-d365-fo-target-system).

## Scripts (from the repository root)

| command | what it does |
|---|---|
| `npm run dev` | server + client with hot reload |
| `npm run check` | lint, type check, tests and build (same as CI) |
| `npm test` | server test suite (API, auth, security, encryption) |
| `npm run build` | production build of the React app |
| `npm start` | start the server (it also serves the React build) |
| `npm run reencrypt --prefix server` | re-encrypt stored secrets after a key rotation |

## Documentation

- [docs/schema-reference.md](docs/schema-reference.md): how to write a schema definition (auth types, placeholders, filters)
- [docs/deployment.md](docs/deployment.md): Azure setup step by step (Entra ID, Cosmos DB or Azure SQL, Key Vault, Container Apps / Web App, pipeline)
- [docs/operations.md](docs/operations.md): monitoring, troubleshooting, key rotation, backups

## Project structure

```
server/
  src/index.js              start-up, config check, graceful shutdown
  src/app.js                Express app: security headers, auth, routes, static files
  src/config.js             all settings (env vars), validated at start-up
  src/middleware/auth.js    Entra ID JWT / Easy Auth, roles
  src/routes/forms.js       forms CRUD, versions, execute, history
  src/services/executor.js  validate → token → build request → call → result
  src/services/outbound-auth.js  6 auth types, token cache, retries
  src/services/secrets.js   encryption, masking, key rotation
  src/services/keyvault.js  {{kv:...}} secrets from Azure Key Vault
  src/repositories/         database access (Knex)
  src/db/migrations/        database schema
  test/                     automated tests
client/
  src/App.tsx               sign-in, layout, routing
  src/lib/auth.ts           MSAL / Easy Auth
  src/lib/validator.ts      CSP-safe form validation
  src/lib/designer.ts       converts the Fields tab to and from JSON Schema
  src/components/           Sidebar, FormRunner, RunHistory, SchemaEditor (designer), ResultCard
Dockerfile                  multi-stage, non-root, health check
azure-pipelines.yml         lint/test/build → image → deploy with approval
```
