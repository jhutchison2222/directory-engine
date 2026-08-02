export interface Env {
  DIRECTORY_DB: D1Database;
  API_KEY: string;
  WORDPRESS_BASE_URL: string;
  WORDPRESS_USERNAME?: string;
  WORDPRESS_APPLICATION_PASSWORD?: string;
  ALLOWED_ORIGINS?: string;
}

export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ProxyOptions {
  query?: URLSearchParams;
  path?: string;
}
