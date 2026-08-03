import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DIRECTORY_DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  DIRECTORY_ENGINE_API_KEY: string;
  DIRECTORY_ENGINE_OAUTH_ACCESS_CODE: string;
  WORDPRESS_BASE_URL: string;
  GEODIRECTORY_CONSUMER_KEY?: string;
  GEODIRECTORY_CONSUMER_SECRET?: string;
  ALLOWED_ORIGINS?: string;
}
