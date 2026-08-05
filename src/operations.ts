import {
  geoPath,
  getDatabaseSchema,
  getDatabaseStatus,
  listSites,
  resolveSiteConnection,
  testConnections,
  VERSION,
  wordpressCollectionPath,
  wordpressGet,
  type ListSitesFilters,
} from "./inspection";
import type { Env } from "./types";

const QUERY_KEYS = new Set([
  "page", "per_page", "search", "slug", "status", "orderby", "order",
  "parent", "post", "post_type", "taxonomy", "country", "region", "city",
  "include", "exclude", "offset", "context",
]);

export function filterQuery(query: URLSearchParams): URLSearchParams {
  const filtered = new URLSearchParams();
  query.forEach((value, key) => {
    if (!QUERY_KEYS.has(key) || value.length > 500) return;
    if (key === "per_page") {
      const perPage = Number(value);
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) return;
    }
    filtered.append(key, value);
  });
  return filtered;
}

function toolQuery(args: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (!QUERY_KEYS.has(key) || value === undefined) throw new Error(`Unsupported argument: ${key}`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`${key} must be a string, number, or boolean`);
    }
    const encoded = String(value);
    if (!encoded || encoded.length > 500) throw new Error(`${key} is invalid`);
    query.set(key, encoded);
  }
  return query;
}

// Tools that need to talk to a specific WordPress/GeoDirectory site. Every
// one of these now accepts an optional `site_id` argument; when omitted,
// resolveSiteConnection() falls back to the legacy single-site env vars,
// so nothing that worked before this change stops working.
const SITE_SCOPED_TOOLS = new Set([
  "list_wordpress_pages",
  "list_wordpress_posts",
  "list_wordpress_categories",
  "list_listing_types",
  "list_taxonomies",
  "list_fields",
  "get_geodirectory_settings",
  "list_locations",
  "list_cities",
]);

function resourcePathFor(name: string): string {
  switch (name) {
    case "list_wordpress_pages":
      return wordpressCollectionPath("pages");
    case "list_wordpress_posts":
      return wordpressCollectionPath("posts");
    case "list_wordpress_categories":
      return wordpressCollectionPath("categories");
    case "list_listing_types":
      return geoPath("listing-types");
    case "list_taxonomies":
      return geoPath("taxonomies");
    case "list_fields":
      return geoPath("fields");
    case "get_geodirectory_settings":
      return geoPath("settings");
    case "list_locations":
      return geoPath("locations");
    case "list_cities":
      return geoPath("cities");
    default:
      throw new Error("Unknown read operation");
  }
}

export async function runReadOperation(
  name: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<unknown> {
  const siteId = typeof args.site_id === "string" ? args.site_id : undefined;
  const { site_id: _siteId, ...rest } = args;

  if (SITE_SCOPED_TOOLS.has(name)) {
    const connection = await resolveSiteConnection(env, siteId);
    return wordpressGet(connection, resourcePathFor(name), toolQuery(rest));
  }

  switch (name) {
    case "health_check":
      return { status: "ok", service: "directory-engine-api", version: VERSION };
    case "test_connections":
      return testConnections(env, siteId);
    case "get_database_status":
      return getDatabaseStatus(env);
    case "get_database_schema":
      return getDatabaseSchema(env);
    case "list_sites":
      return listSites(env, rest as ListSitesFilters);
    default:
      throw new Error("Unknown read operation");
  }
}
