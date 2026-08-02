import type { Env } from "./types";

export const VERSION = "0.2.0";
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_BYTES = 1_048_576;
const MAX_UPSTREAM_ATTEMPTS = 3;

export const ROUTES = {
  wordpress: ["pages", "posts", "categories"],
  geodirectory: ["listing-types", "taxonomies", "fields", "settings", "locations", "cities"],
} as const;

function wordpressHeaders(env: Env): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (env.WORDPRESS_USERNAME && env.WORDPRESS_APPLICATION_PASSWORD) {
    headers.set(
      "authorization",
      `Basic ${btoa(`${env.WORDPRESS_USERNAME}:${env.WORDPRESS_APPLICATION_PASSWORD}`)}`,
    );
  }
  return headers;
}

function baseUrl(env: Env): URL {
  if (!env.WORDPRESS_BASE_URL) throw new Error("WORDPRESS_BASE_URL is not configured");
  const url = new URL(env.WORDPRESS_BASE_URL.replace(/\/$/, "") + "/");
  if (url.protocol !== "https:") throw new Error("WORDPRESS_BASE_URL must use HTTPS");
  if (url.username || url.password) throw new Error("WORDPRESS_BASE_URL must not contain credentials");
  return url;
}

export async function wordpressGet(
  env: Env,
  path: string,
  query = new URLSearchParams(),
): Promise<unknown> {
  const url = new URL(path.replace(/^\//, ""), baseUrl(env));
  url.search = query.toString();
  let response: Response | undefined;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    response = await fetch(url, {
      headers: wordpressHeaders(env),
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (response.status < 500 && response.status !== 429) break;
    if (attempt < MAX_UPSTREAM_ATTEMPTS) await response.body?.cancel();
  }
  if (!response) throw new Error("WordPress request failed");
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new UpstreamError(502, { error: "redirect rejected" });
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_UPSTREAM_BYTES) {
    await response.body?.cancel();
    throw new UpstreamError(502, { error: "response too large" });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_UPSTREAM_BYTES) throw new UpstreamError(502, { error: "response too large" });
  const text = new TextDecoder().decode(bytes);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text };
  }
  if (!response.ok) throw new UpstreamError(response.status, body);
  return body;
}

export class UpstreamError extends Error {
  constructor(public readonly status: number, public readonly detail: unknown) {
    super(`WordPress returned HTTP ${status}`);
  }
}

export async function getDatabaseStatus(env: Env) {
  const result = await env.DIRECTORY_DB.prepare(`
    SELECT COUNT(*) AS table_count
      FROM sqlite_schema
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).first<{ table_count: number }>();
  return {
    connected: true,
    binding: "DIRECTORY_DB",
    table_count: result?.table_count ?? 0,
  };
}

export async function getDatabaseSchema(env: Env) {
  const result = await env.DIRECTORY_DB.prepare(`
    SELECT m.name AS table_name, p.cid, p.name AS column_name, p.type,
           p."notnull" AS not_null, p.dflt_value AS default_value, p.pk AS primary_key
      FROM sqlite_schema AS m
      JOIN pragma_table_info(m.name) AS p
     WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
     ORDER BY m.name, p.cid
  `).all<{
    table_name: string;
    cid: number;
    column_name: string;
    type: string;
    not_null: number;
    default_value: string | null;
    primary_key: number;
  }>();
  const tables: Record<string, unknown[]> = {};
  for (const column of result.results ?? []) {
    const { table_name, ...definition } = column;
    (tables[table_name] ??= []).push(definition);
  }
  return { binding: "DIRECTORY_DB", tables };
}

export async function testConnections(env: Env) {
  const [database, wordpress, geodirectory] = await Promise.allSettled([
    getDatabaseStatus(env),
    wordpressGet(env, "wp-json/"),
    wordpressGet(env, "wp-json/geodir/v2/"),
  ]);
  const state = (result: PromiseSettledResult<unknown>) => ({
    connected: result.status === "fulfilled",
    ...(result.status === "rejected" ? { error: safeError(result.reason) } : {}),
  });
  return {
    database: state(database),
    wordpress: state(wordpress),
    geodirectory: state(geodirectory),
  };
}

export function safeError(error: unknown): string {
  if (error instanceof UpstreamError) return `upstream HTTP ${error.status}`;
  return error instanceof Error ? error.message : "unknown error";
}

export function wordpressCollectionPath(resource: string): string {
  return `wp-json/wp/v2/${resource}`;
}

export function geoPath(resource: string): string {
  const paths: Record<string, string> = {
    "listing-types": "wp-json/geodir/v2/types",
    taxonomies: "wp-json/geodir/v2/taxonomies",
    fields: "wp-json/geodir/v2/fields",
    settings: "wp-json/geodir/v2/settings",
    locations: "wp-json/geodir/v2/locations",
    cities: "wp-json/geodir/v2/locations/cities",
  };
  const path = paths[resource];
  if (!path) throw new Error("Unsupported GeoDirectory resource");
  return path;
}
