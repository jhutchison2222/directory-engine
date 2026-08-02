# Deploying the v0.2.0 inspection Worker and MCP upgrade

This deployment preserves the existing read-only Directory Engine Worker. It
must be bound to the already deployed D1 database; do not create a replacement
database and do not apply a new schema or migration.

## Required configuration contract

| Kind | Name | Purpose |
| --- | --- | --- |
| D1 binding | `DIRECTORY_DB` | Existing 21-table directory database |
| Variable | `WORDPRESS_BASE_URL` | WordPress site origin |
| Variable | `ALLOWED_ORIGINS` | Comma-separated browser origins allowed by CORS |
| Secret | `API_KEY` | Authorizes `/v1/*` and `/mcp` |
| Optional secret | `WORDPRESS_USERNAME` | WordPress REST Basic Auth user |
| Optional secret | `WORDPRESS_APPLICATION_PASSWORD` | WordPress application password |

The example configuration contains placeholders only. Do not commit a copied
`wrangler.toml`, `.dev.vars`, API key, WordPress credential, account ID, or real
database ID.

## Configure without exposing secrets

```sh
cp wrangler.example.toml wrangler.toml
# Set the existing DIRECTORY_DB database_id in the ignored wrangler.toml.
npx wrangler secret put API_KEY
# Only if the deployed WordPress REST API requires them:
npx wrangler secret put WORDPRESS_USERNAME
npx wrangler secret put WORDPRESS_APPLICATION_PASSWORD
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

Review the dry-run binding list and verify it says `DIRECTORY_DB`. There are no
schema or migration files in this upgrade because D1 is inspected in place.

## Deploy

```sh
npm run deploy
```

The REST API rejects mutation methods and the MCP registry contains only
inspection tools. Cloudflare and WordPress credentials are never returned in
responses or connection-test errors.

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

Initialize MCP and list its tools:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $DIRECTORY_ENGINE_API_KEY" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0.0"}}}' \
  "$DIRECTORY_ENGINE_URL/mcp"
curl --fail-with-body \
  -H "Authorization: Bearer $DIRECTORY_ENGINE_API_KEY" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  "$DIRECTORY_ENGINE_URL/mcp"
```

## CORS and authorization checks

Only exact origins in `ALLOWED_ORIGINS` receive an
`Access-Control-Allow-Origin` header. API clients without an `Origin` header can
still call the service, but all protected endpoints require the API key. Rotate
the key with `wrangler secret put API_KEY`; never log it.

## Rollback

Roll back the Worker deployment through Wrangler or the Cloudflare dashboard.
Because this release neither migrates nor writes D1, Worker rollback does not
require a database rollback. Use `npx wrangler tail` for operational diagnosis;
request failures are sanitized before being returned to clients.
