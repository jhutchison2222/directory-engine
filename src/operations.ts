import {
  getDatabaseSchema,
  getDatabaseStatus,
  geoPath,
  testConnections,
  VERSION,
  wordpressCollectionPath,
  wordpressGet,
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
    if (QUERY_KEYS.has(key) && value.length <= 500) filtered.append(key, value);
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

export async function runReadOperation(
  name: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<unknown> {
  switch (name) {
    case "health_check":
      return { status: "ok", service: "directory-engine", version: VERSION };
    case "test_connections":
      return testConnections(env);
    case "get_database_status":
      return getDatabaseStatus(env);
    case "get_database_schema":
      return getDatabaseSchema(env);
    case "list_wordpress_pages":
      return wordpressGet(env, wordpressCollectionPath("pages"), toolQuery(args));
    case "list_wordpress_posts":
      return wordpressGet(env, wordpressCollectionPath("posts"), toolQuery(args));
    case "list_wordpress_categories":
      return wordpressGet(env, wordpressCollectionPath("categories"), toolQuery(args));
    case "list_listing_types":
      return wordpressGet(env, geoPath("listing-types"), toolQuery(args));
    case "list_taxonomies":
      return wordpressGet(env, geoPath("taxonomies"), toolQuery(args));
    case "list_fields":
      return wordpressGet(env, geoPath("fields"), toolQuery(args));
    case "get_geodirectory_settings":
      return wordpressGet(env, geoPath("settings"), toolQuery(args));
    case "list_locations":
      return wordpressGet(env, geoPath("locations"), toolQuery(args));
    case "list_cities":
      return wordpressGet(env, geoPath("cities"), toolQuery(args));
    default:
      throw new Error("Unknown read operation");
  }
}
