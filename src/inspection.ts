import type { Env } from "./types";

export const VERSION = "0.4.0";
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_BYTES = 1_048_576;
const MAX_UPSTREAM_ATTEMPTS = 3;

export const ROUTES = {
  wordpress: ["pages", "posts", "categories"],
  geodirectory: ["listing-types", "taxonomies", "fields", "settings", "locations", "cities"],
} as const;

export class UpstreamError extends Error {
  constructor(public readonly status: number, public readonly detail: unknown) {
    super(`WordPress returned HTTP ${status}`);
  }
}

/**
 * A resolved WordPress/GeoDirectory connection for a single site -- built
 * either from a `sites` + `integration_connections` row (multi-site path)
 * or from the legacy env vars (single-site fallback, used whenever no
 * site_id is supplied). See worker-multisite-scoping.md for the design.
 */
export interface SiteConnection {
  siteId: string | null;
  baseUrl: URL;
  consumerKey?: string;
  consumerSecret?: string;
}

interface SiteRow {
  id: string;
  site_key: string;
  name: string;
  base_url: string;
  site_role: string;
  status: string;
}

interface IntegrationConnectionRow {
  id: string;
  site_id: string;
  provider: string;
  status: string;
  secret_reference: string | null;
  configuration_json: string | null;
}

function parseBaseUrl(rawUrl: string, sourceLabel: string): URL {
  if (!rawUrl) throw new Error(`${sourceLabel} is not configured`);
  const url = new URL(rawUrl.replace(/\/$/, "") + "/");
  if (url.protocol !== "https:") throw new Error(`${sourceLabel} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${sourceLabel} must not contain credentials`);
  return url;
}

/**
 * Resolve which WordPress site a request should talk to.
 *
 * - siteId provided: look up `sites` (by id or site_key) for the base URL,
 *   and the matching `integration_connections` row (provider = 'wordpress')
 *   for credentials. The connection's secret_reference names a Worker
 *   secret / Secrets Store binding holding a JSON string like
 *   {"consumerKey": "...", "consumerSecret": "..."}. Real credentials
 *   never pass through this codebase as plain columns -- only a pointer
 *   to where they live.
 * - siteId omitted: fall back to the original single-site env vars
 *   (WORDPRESS_BASE_URL / GEODIRECTORY_CONSUMER_KEY / GEODIRECTORY_CONSUMER_SECRET).
 *   This keeps every existing caller working unchanged during migration --
 *   nothing breaks for the site that's already wired up today.
 */
export async function resolveSiteConnection(env: Env, siteId?: string | null): Promise<SiteConnection> {
  if (!siteId) {
    return {
      siteId: null,
      baseUrl: parseBaseUrl(env.WORDPRESS_BASE_URL, "WORDPRESS_BASE_URL"),
      consumerKey: env.GEODIRECTORY_CONSUMER_KEY,
      consumerSecret: env.GEODIRECTORY_CONSUMER_SECRET,
    };
  }

  const site = await env.DIRECTORY_DB.prepare(
    `SELECT id, site_key, name, base_url, site_role, status FROM sites WHERE id = ? OR site_key = ? LIMIT 1`,
  )
    .bind(siteId, siteId)
    .first<SiteRow>();
  if (!site) throw new Error(`Unknown site_id: ${siteId}`);

  const baseUrl = parseBaseUrl(site.base_url, `sites.base_url for ${siteId}`);

  const connection = await env.DIRECTORY_DB.prepare(
    `SELECT id, site_id, provider, status, secret_reference, configuration_json
       FROM integration_connections
      WHERE site_id = ? AND provider = 'wordpress'
      ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(site.id)
    .first<IntegrationConnectionRow>();

  if (!connection || connection.status !== "active") {
    // No active credentials registered yet for this site. Public,
    // unauthenticated WordPress REST reads can still work; anything
    // requiring Basic auth (most GeoDirectory endpoints) will correctly
    // fail upstream with a 401 until the connection is actually set up.
    return { siteId: site.id, baseUrl };
  }

  let consumerKey: string | undefined;
  let consumerSecret: string | undefined;
  if (connection.secret_reference) {
    const rawSecret = env[connection.secret_reference];
    if (typeof rawSecret !== "string" || !rawSecret) {
      throw new Error(
        `Secret binding "${connection.secret_reference}" for site ${siteId} is not configured on this Worker`,
      );
    }
    try {
      const parsed = JSON.parse(rawSecret) as { consumerKey?: unknown; consumerSecret?: unknown };
      consumerKey = typeof parsed.consumerKey === "string" ? parsed.consumerKey : undefined;
      consumerSecret = typeof parsed.consumerSecret === "string" ? parsed.consumerSecret : undefined;
    } catch {
      throw new Error(`Secret binding "${connection.secret_reference}" for site ${siteId} is not valid JSON`);
    }
  }

  return { siteId: site.id, baseUrl, consumerKey, consumerSecret };
}

function wordpressHeaders(connection: SiteConnection): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (connection.consumerKey && connection.consumerSecret) {
    headers.set(
      "authorization",
      `Basic ${btoa(`${connection.consumerKey}:${connection.consumerSecret}`)}`,
    );
  }
  return headers;
}

export async function wordpressGet(
  connection: SiteConnection,
  path: string,
  query = new URLSearchParams(),
): Promise<unknown> {
  const url = new URL(path.replace(/^\//, ""), connection.baseUrl);
  url.search = query.toString();
  let response: Response | undefined;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    response = await fetch(url, {
      headers: wordpressHeaders(connection),
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

export interface ListSitesFilters {
  status?: string;
  site_role?: string;
}

export async function listSites(env: Env, filters: ListSitesFilters = {}) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.site_role) {
    conditions.push("site_role = ?");
    params.push(filters.site_role);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.DIRECTORY_DB.prepare(
    `SELECT id, site_key, name, base_url, site_role, archetype_id, wordpress_site_id, status, timezone, default_country_code, created_at, updated_at
       FROM sites ${where} ORDER BY name ASC LIMIT 200`,
  )
    .bind(...params)
    .all();
  return { items: result.results ?? [] };
}

export async function testConnections(env: Env, siteId?: string | null) {
  const [database, connectionResult] = await Promise.allSettled([
    getDatabaseStatus(env),
    resolveSiteConnection(env, siteId),
  ]);

  const state = (result: PromiseSettledResult<unknown>) => ({ connected: result.status === "fulfilled" });

  if (connectionResult.status !== "fulfilled") {
    return {
      database: state(database),
      wordpress: { connected: false },
      geodirectory: { connected: false },
      site_id: siteId ?? null,
    };
  }

  const connection = connectionResult.value;
  const [wordpress, geodirectory] = await Promise.allSettled([
    wordpressGet(connection, "wp-json/"),
    wordpressGet(connection, "wp-json/geodir/v2/"),
  ]);

  return {
    database: state(database),
    wordpress: state(wordpress),
    geodirectory: state(geodirectory),
    site_id: connection.siteId,
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
