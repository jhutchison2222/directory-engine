export interface Env {
  DIRECTORY_DB: D1Database;
  DIRECTORY_ENGINE_API_KEY: string;
  DIRECTORY_ENGINE_WRITE_API_KEY: string;

  // Legacy single-site connection (fallback path -- used whenever a request
  // or tool call omits site_id). Kept working unchanged so nothing that
  // depends on today's single-site behavior breaks during the multi-site
  // rollout described in worker-multisite-scoping.md.
  WORDPRESS_BASE_URL: string;
  GEODIRECTORY_CONSUMER_KEY?: string;
  GEODIRECTORY_CONSUMER_SECRET?: string;

  ALLOWED_ORIGINS?: string;

  // Per-site WordPress/GeoDirectory credentials are bound dynamically by
  // name: integration_connections.secret_reference names a Worker
  // secret/Secrets Store binding holding a JSON string of the form
  // {"consumerKey": "...", "consumerSecret": "..."}. This index signature
  // is what makes that dynamic lookup (env[secretReference]) type-check.
  [secretBindingName: string]: unknown;
}
