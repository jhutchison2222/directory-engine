# v0.2.0 baseline comparison

The preserved deployed source is
[`reference/directory-engine-api-worker.js`](../reference/directory-engine-api-worker.js).
It is retained as a review reference and is not the Wrangler entry point. A
credential-pattern scan is part of validation; the file contains binding and
secret **names** but no values.

| Baseline behavior | TypeScript implementation | Regression coverage |
| --- | --- | --- |
| `GET /health` | `src/index.ts` | public health test |
| API key via bearer or `X-Directory-Engine-Key` | `src/security.ts` | both-header and rejection tests |
| Exact-origin CORS and request IDs | `src/security.ts` | CORS, preflight, and request-ID tests |
| `GET /v1/capabilities` | `src/index.ts` | capabilities test |
| `GET /v1/connection-test` | `src/inspection.ts` | connection response test |
| `GET /v1/database/status` | `src/inspection.ts` | 21-table status test |
| `GET /v1/database/schema` | `src/inspection.ts` | grouped schema test |
| WordPress pages, posts, categories and item routes | `src/index.ts` | parameterized route table |
| GeoDirectory `/types`, `/taxonomies`, `/fields`, `/settings`, `/locations`, `/locations/cities` | `src/inspection.ts` | parameterized route table |
| HTTPS, query, redirect, retry, and response limits | `src/inspection.ts`, `src/operations.ts` | upstream protection tests |
| Read-only methods | `src/index.ts` | write-method rejection test |

The TypeScript Worker adds only authenticated `POST /mcp` and its matching
preflight behavior. MCP operations call the same inspection functions as REST;
they do not modify the preserved REST paths or introduce database writes.
