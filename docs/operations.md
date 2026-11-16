# Operations

## Monitoring

**Logs**: every request is logged as one JSON line with `req.id` (the same ID the user sees as *Reference for
support*). Tokens, secrets and auth headers are redacted. Container Apps sends the logs to Log Analytics:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "schema-forms"
| extend e = parse_json(Log_s)
| where e.msg in ("form execution failed", "unhandled error")
| project TimeGenerated, form = e.formId, stage = e.stage, status = e.status, requestId = e.req.id, msg = e.msg
| order by TimeGenerated desc
```

Find one user's problem from their reference ID:

```kusto
ContainerAppConsoleLogs_CL | where Log_s has "<reference id>"
```

**Application Insights** (when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set) collects requests, outgoing calls
(token + target API), exceptions, and a custom event per submit:

```kusto
customEvents
| where name == "FormExecuted"
| summarize total = count(), failed = countif(tostring(customDimensions.ok) == "false"),
            p95_ms = percentile(todouble(customMeasurements.durationMs), 95) by formId = tostring(customDimensions.formId)
```

Suggested alerts: failed submits > N in 15 min, `/health/ready` failing, exceptions > 0.

**Health endpoints**: `/health/live` (process up) and `/health/ready` (database reachable).

## Run history and audit

- Every submit is stored in `executions`: user, form version, result, timings, the request (secrets masked) and the response.
- Every schema change is stored in `form_versions` with who and when. Deleting a form is a soft delete and is also versioned.
- History older than `HISTORY_RETENTION_DAYS` (default 90) is removed daily.
- Set `HISTORY_STORE_PAYLOADS=false` if request or response bodies may contain personal data that must not be kept.

## Rotating the encryption key

Secrets typed directly into schemas are encrypted with `SECRET_ENCRYPTION_KEY`. To rotate it:

1. Create a new key: `openssl rand -base64 32` and store it in Key Vault.
2. Set `SECRET_ENCRYPTION_KEY=<new>` and `SECRET_ENCRYPTION_KEYS_PREVIOUS=<old>`, then deploy. Old values stay readable.
3. Run the re-encryption once, with the same settings, for example as a Container Apps job using the same image:
   `node server/scripts/reencrypt.js`
4. Remove `SECRET_ENCRYPTION_KEYS_PREVIOUS`.

If the key is lost, the stored secrets cannot be recovered; re-enter them in the forms. Secrets kept in Key Vault
(`{{kv:...}}`) do not depend on this key, which is one more reason to prefer Key Vault.

## Backups and restore

Azure SQL makes automatic backups (point-in-time restore, 7 days by default; configure long-term retention if your
policy needs it). All application state lives in the database; the container is stateless.

## Scaling

The container is stateless, so several replicas can run behind the Container Apps ingress. Each replica keeps its
own token cache, which only means one token request per replica.

## Troubleshooting

| message the user / admin sees | cause | fix |
|---|---|---|
| *No access … assign you the "SchemaForms.User" role* | user has no app role | assign the role in Enterprise applications |
| *Your session has expired* | Entra token expired | sign in again (the app does this automatically) |
| *AADSTS7000215: Invalid client secret* | wrong / expired F&O app secret | update the secret in Key Vault |
| *AADSTS700016: Application … not found* | wrong client ID or tenant | check `FNO_CLIENT_ID` / `FNO_TENANT_ID` |
| F&O returns **401** | app not registered in F&O | F&O → *Microsoft Entra applications* (deployment.md §5) |
| F&O returns **403** | the mapped F&O user lacks security roles | add roles to that user |
| *Host "…" is not in ALLOWED_HOSTS* | target host not allowed | add it to `ALLOWED_HOSTS` and restart |
| *Environment variable "X" is not set* | `{{env:X}}` used but missing | add the app setting |
| *Key Vault secret "x": access denied* | identity lacks the role | grant *Key Vault Secrets User* |
| *Stored secrets could not be decrypted* | encryption key changed | restore the old key as `SECRET_ENCRYPTION_KEYS_PREVIOUS` |
| *This form was changed by …* (409) | two admins edited at the same time | click **Load latest version** and re-apply the change |
| *Too many submissions* (429) | rate limit | wait a minute or raise `RATE_LIMIT_EXECUTE_PER_MIN` |
| App does not start, log says *Configuration is not valid* | missing/unsafe setting | the log lists every problem |
