# Deploying the v0.3.0 OAuth-protected MCP Worker

This deployment preserves the existing read-only Directory Engine Worker. It
must be bound to the already deployed D1 database; do not create a replacement
database and do not apply a new schema or migration.
The Wrangler service name remains `directory-engine-api`.

## Required configuration contract

| Kind | Name | Purpose |
| --- | --- | --- |
| D1 binding | `DIRECTORY_DB` | Existing 21-table directory database |
| KV binding | `OAUTH_KV` | Dedicated OAuth grants and tokens |
| Variable | `WORDPRESS_BASE_URL` | WordPress site origin |
| Variable | `ALLOWED_ORIGINS` | Comma-separated browser origins allowed by CORS |
| Secret | `DIRECTORY_ENGINE_API_KEY` | Authorizes `/v1/*` |
| Secret | `DIRECTORY_ENGINE_OAUTH_ACCESS_CODE` | Owner approval on `/authorize` |
| Optional secret | `GEODIRECTORY_CONSUMER_KEY` | GeoDirectory REST consumer key |
| Optional secret | `GEODIRECTORY_CONSUMER_SECRET` | GeoDirectory REST consumer secret |

The example configuration contains placeholders only. The active `wrangler.toml`
commits the Worker and D1 identifiers, but no secret values. Do not commit
`.dev.vars`, API keys, or GeoDirectory credentials.

## Configure without exposing secrets

```sh
npx wrangler secret put DIRECTORY_ENGINE_API_KEY
npx wrangler secret put DIRECTORY_ENGINE_OAUTH_ACCESS_CODE
# Only if the deployed GeoDirectory REST API requires them:
npx wrangler secret put GEODIRECTORY_CONSUMER_KEY
npx wrangler secret put GEODIRECTORY_CONSUMER_SECRET
```

Use CI secret storage instead of interactive commands in automated deployments.
Do not prefix secrets with `VITE_`, `PUBLIC_`, or any other client-exposed name.

## Validate before deployment

```sh
npm ci
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

Review the dry-run binding list and verify it contains the existing `DIRECTORY_DB`
and the new dedicated `OAUTH_KV`. There are no schema or migration files in this
upgrade because D1 is inspected in place.

## Deploy

```sh
npm run deploy
```

The REST API rejects mutation methods and the MCP registry contains only
inspection tools. Cloudflare and WordPress credentials are never returned in
responses or connection-test errors.

The upstream client accepts HTTPS only, does not follow redirects, limits
responses to 1 MiB, and makes at most three attempts for HTTP 429 and 5xx
responses. Do not weaken these controls during deployment.

## Smoke test

Use shell variables supplied outside Git:

```sh
export DIRECTORY_ENGINE_URL='https://directory-engine.example.workers.dev'
read -rsp 'Directory Engine API key: ' DIRECTORY_ENGINE_API_KEY; echo

curl --fail-with-body "$DIRECTORY_ENGINE_URL/health"
curl --fail-with-body \
  -H "Authorization: Bearer $DIRECTORY_ENGINE_API_KEY" \
  "$DIRECTORY_ENGINE_URL/v1/capabilities"
curl --fail-with-body \
  -H "Authorization: Bearer $DIRECTORY_ENGINE_API_KEY" \
  "$DIRECTORY_ENGINE_URL/v1/connection-test"
curl --fail-with-body \
  -H "Authorization: Bearer $DIRECTORY_ENGINE_API_KEY" \
  "$DIRECTORY_ENGINE_URL/v1/database/status"
```

The database status should report the existing table count (21 for the deployed
v0.2.0 baseline) and binding `DIRECTORY_DB`.

Verify OAuth discovery before connecting ChatGPT:

```sh
curl --include \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  "$DIRECTORY_ENGINE_URL/mcp"
curl --fail-with-body \
  "$DIRECTORY_ENGINE_URL/.well-known/oauth-protected-resource/mcp"
curl --fail-with-body \
  "$DIRECTORY_ENGINE_URL/.well-known/oauth-authorization-server"
```

The first request must return HTTP 401 with a `WWW-Authenticate` challenge
containing `resource_metadata`. Complete the OAuth authorization from ChatGPT,
then initialize and list tools through the authenticated app. `tools/list` must
return exactly the 13 documented read-only tools.

## CORS and authorization checks

Only exact origins in `ALLOWED_ORIGINS` receive an
`Access-Control-Allow-Origin` header. API clients without an `Origin` header can
still call the REST service, but `/v1/*` requires the API key and `/mcp` requires
an OAuth token issued for the exact MCP resource. Rotate
the key with `wrangler secret put DIRECTORY_ENGINE_API_KEY`; never log it.
Wildcard origins are intentionally unsupported. The Worker accepts or generates
an `X-Request-ID` and returns it on all REST and MCP responses.

## Rollback

Roll back the Worker deployment through Wrangler or the Cloudflare dashboard.
Because this release neither migrates nor writes D1, Worker rollback does not
require a database rollback. Use `npx wrangler tail` for operational diagnosis;
request failures are sanitized before being returned to clients.


## OAuth configuration before merge

After review, create a new KV namespace dedicated to this Worker and add its ID
to the existing `wrangler.toml` without changing `DIRECTORY_DB`:

```sh
npx wrangler kv namespace create OAUTH_KV
```

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<new namespace ID>"
```

The OAuth contract is:

- resource: `https://directory-engine-api.jhutchison.workers.dev/mcp`
- authorization endpoint: `/authorize`
- token endpoint: `/oauth/token`
- dynamic client registration: `/oauth/register`
- scope: `mcp:read`
- PKCE: S256 only
- access tokens: 1 hour
- rotating refresh tokens: 30 days

Do not merge until the production `OAUTH_KV` binding is committed and
`DIRECTORY_ENGINE_OAUTH_ACCESS_CODE` is stored as a Worker secret. Never paste
that secret into ChatGPT messages, GitHub, logs, URLs, or source files.

