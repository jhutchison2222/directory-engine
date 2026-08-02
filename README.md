# Directory Engine

Directory Engine v0.2.0 is the deployed, read-only Cloudflare Worker for
inspecting WordPress, GeoDirectory, and an existing D1 database. This repository
preserves that REST contract and adds a stateless, read-only MCP endpoint at
`/mcp`.

The live Worker name remains `directory-engine-api`.
The deployed v0.2.0 JavaScript baseline is preserved for review at
[`reference/directory-engine-api-worker.js`](reference/directory-engine-api-worker.js),
with a route-by-route comparison in
[`docs/baseline-comparison.md`](docs/baseline-comparison.md).

It is **not** a public directory-search service. It does not create, migrate, or
replace the deployed 21-table D1 database, and it exposes no write operations.

## Preserved HTTP API

`GET /health` is public. Every `/v1/*` route and `POST /mcp` requires the
configured `DIRECTORY_ENGINE_API_KEY`, supplied either as
`Authorization: Bearer <DIRECTORY_ENGINE_API_KEY>` or
`X-Directory-Engine-Key: <DIRECTORY_ENGINE_API_KEY>`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Worker health and v0.2.0 identity |
| `GET` | `/v1/capabilities` | Read-only routes, binding, and MCP tools |
| `GET` | `/v1/connection-test` | Test D1, WordPress, and GeoDirectory reads |
| `GET` | `/v1/database/status` | D1 connectivity and existing table count |
| `GET` | `/v1/database/schema` | Inspect existing D1 tables and columns |
| `GET` | `/v1/wordpress/pages[/:id]` | Proxy WordPress pages |
| `GET` | `/v1/wordpress/posts[/:id]` | Proxy WordPress posts |
| `GET` | `/v1/wordpress/categories[/:id]` | Proxy WordPress categories |
| `GET` | `/v1/geodirectory/listing-types` | Inspect listing types |
| `GET` | `/v1/geodirectory/taxonomies` | Inspect taxonomies |
| `GET` | `/v1/geodirectory/fields` | Inspect custom fields |
| `GET` | `/v1/geodirectory/settings` | Inspect settings |
| `GET` | `/v1/geodirectory/locations` | Inspect locations |
| `GET` | `/v1/geodirectory/cities` | Inspect cities |
| `POST` | `/mcp` | Stateless MCP Streamable HTTP requests |

Collection query strings are limited to known read-only WordPress and
GeoDirectory parameters. Non-GET REST methods are rejected.

The Worker preserves caller `X-Request-ID` values (or generates one), allows
CORS only for exact configured origins, requires HTTPS WordPress URLs, refuses
upstream redirects, retries bounded transient failures, and caps upstream
responses at 1 MiB.

## MCP tools

The MCP server exposes the same reads as the REST Worker:

- `health_check`
- `test_connections`
- `get_database_status`
- `get_database_schema`
- `list_listing_types`
- `list_taxonomies`
- `list_fields`
- `get_geodirectory_settings`
- `list_locations`
- `list_cities`
- `list_wordpress_pages`
- `list_wordpress_posts`
- `list_wordpress_categories`

Every tool declares read-only, non-destructive annotations. There are no create,
update, delete, publish, migration, SQL execution, or other mutation tools.

## Configuration

Copy `wrangler.example.toml` to the ignored `wrangler.toml` and supply the
existing D1 database ID. The deployed binding and configuration names are:

- D1 binding: `DIRECTORY_DB`
- Variable: `WORDPRESS_BASE_URL`
- Variable: `ALLOWED_ORIGINS` (comma-separated exact origins)
- Secret: `DIRECTORY_ENGINE_API_KEY`
- Optional secrets: `WORDPRESS_USERNAME`, `WORDPRESS_APPLICATION_PASSWORD`

No secret values belong in Git. See [the deployment guide](docs/deployment.md)
for safe configuration, validation, and smoke-test commands.

## Development

```sh
npm install
cp wrangler.example.toml wrangler.toml
npm test
npm run typecheck
npm run dev
```
