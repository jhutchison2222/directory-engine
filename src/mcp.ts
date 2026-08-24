import { runReadOperation } from "./operations";
import { corsHeaders, isWriteAuthorized, jsonResponse } from "./security";
import type { Env } from "./types";
import { runWriteOperation } from "./write-operations";

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";

const collectionProperties = {
  page: { type: "integer", minimum: 1 },
  per_page: { type: "integer", minimum: 1, maximum: 100 },
  search: { type: "string", maxLength: 500 },
} as const;

// Every WordPress/GeoDirectory-scoped tool takes this optional argument now.
// Omitting it falls back to the legacy single-site env vars -- see
// resolveSiteConnection() in inspection.ts.
const siteScopeProperty = { site_id: { type: "string", maxLength: 100 } } as const;

type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  annotations: Partial<ToolAnnotations> = {},
) => ({
  name,
  description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    ...annotations,
  },
  inputSchema: { type: "object", properties, additionalProperties: false },
});

const READ_TOOLS = [
  tool("health_check", "Return the Directory Engine service version and health."),
  tool(
    "test_connections",
    "Test read access to D1, and to WordPress/GeoDirectory for a given site (or the legacy default site if site_id is omitted).",
    { ...siteScopeProperty },
  ),
  tool("get_database_status", "Return D1 connectivity and table count."),
  tool("get_database_schema", "Inspect tables and columns in the existing D1 database."),
  tool(
    "list_sites",
    "List registered sites (the source of truth for which WordPress installs exist -- master, niche templates, and end sites).",
    { status: { type: "string", maxLength: 40 }, site_role: { type: "string", maxLength: 40 } },
  ),
  tool("list_listing_types", "List GeoDirectory listing types for a site.", { ...collectionProperties, ...siteScopeProperty }),
  tool("list_taxonomies", "List GeoDirectory taxonomies for a site.", {
    ...collectionProperties, ...siteScopeProperty, post_type: { type: "string" },
  }),
  tool("list_fields", "List GeoDirectory custom fields for a site.", {
    ...collectionProperties, ...siteScopeProperty, post_type: { type: "string" },
  }),
  tool("get_geodirectory_settings", "Read GeoDirectory settings for a site.", { ...siteScopeProperty }),
  tool("list_locations", "List GeoDirectory locations for a site.", {
    ...collectionProperties, ...siteScopeProperty,
    country: { type: "string" }, region: { type: "string" }, city: { type: "string" },
  }),
  tool("list_cities", "List GeoDirectory cities for a site.", {
    ...collectionProperties, ...siteScopeProperty, country: { type: "string" }, region: { type: "string" },
  }),
  tool("list_wordpress_pages", "List WordPress pages for a site.", {
    ...collectionProperties, ...siteScopeProperty, slug: { type: "string" },
  }),
  tool("list_wordpress_posts", "List WordPress posts for a site.", {
    ...collectionProperties, ...siteScopeProperty, slug: { type: "string" },
  }),
  tool("list_wordpress_categories", "List WordPress categories for a site.", {
    ...collectionProperties, ...siteScopeProperty, parent: { type: "integer" },
  }),
];

// Restores the write tools that are already live in production (deployed
// directly via the dashboard as v0.3.0) but were never brought back into
// this repo, plus the two new site-registry tools from the multi-site
// scoping work. See worker-multisite-scoping.md.
const WRITE_TOOLS = [
  tool(
    "upsert_site_profile",
    "Deprecated -- use upsert_site instead. Kept working for backward compatibility only. Requires a write key.",
    {
      id: { type: "string", maxLength: 100 },
      domain: { type: "string", maxLength: 255 },
      niche: { type: "string", maxLength: 120 },
      scope_level: { type: "string", maxLength: 40 },
      scope_value: { type: "string", maxLength: 200 },
      url_depth: { type: "string", maxLength: 40 },
      wp_listing_path: { type: "string", maxLength: 255 },
      status: { type: "string", maxLength: 40 },
    },
    { readOnlyHint: false },
  ),
  tool(
    "upsert_site",
    "Create or update a site (master template, niche template, or end site) -- the source of truth for what sites exist and where they live. Requires a write key.",
    {
      id: { type: "string", maxLength: 100 },
      site_key: { type: "string", maxLength: 80 },
      name: { type: "string", maxLength: 200 },
      base_url: { type: "string", maxLength: 255 },
      site_role: { type: "string", maxLength: 40 },
      archetype_id: { type: "string", maxLength: 100 },
      wordpress_site_id: { type: "string", maxLength: 100 },
      status: { type: "string", maxLength: 40 },
      timezone: { type: "string", maxLength: 60 },
      default_country_code: { type: "string", maxLength: 10 },
    },
    { readOnlyHint: false },
  ),
  tool(
    "upsert_integration_connection",
    "Register or update a site's connection to an external system (e.g. WordPress/GeoDirectory). secret_reference names a Worker/Secrets Store binding -- the actual credential value is never passed through this tool. Requires a write key.",
    {
      id: { type: "string", maxLength: 100 },
      site_id: { type: "string", maxLength: 100 },
      provider: { type: "string", maxLength: 40 },
      connection_key: { type: "string", maxLength: 200 },
      status: { type: "string", maxLength: 40 },
      secret_reference: { type: "string", maxLength: 200 },
    },
    { readOnlyHint: false },
  ),
  tool(
    "upsert_master_listing",
    "Create or update a listing in the central catalog. Requires a write key.",
    {
      id: { type: "string", maxLength: 100 },
      source: { type: "string", maxLength: 60 },
      source_id: { type: "string", maxLength: 255 },
      name: { type: "string", maxLength: 255 },
      category: { type: "string", maxLength: 120 },
      address: { type: "string", maxLength: 255 },
      city: { type: "string", maxLength: 120 },
      region: { type: "string", maxLength: 120 },
      country: { type: "string", maxLength: 120 },
      lat: { type: "number" },
      lng: { type: "number" },
      phone: { type: "string", maxLength: 40 },
      website: { type: "string", maxLength: 500 },
      status: { type: "string", maxLength: 40 },
    },
    { readOnlyHint: false },
  ),
  tool(
    "upsert_listing_site_link",
    "Link a master catalog listing to a specific site and record its publish status on that site. Requires a write key.",
    {
      listing_id: { type: "string", maxLength: 100 },
      site_id: { type: "string", maxLength: 100 },
      wp_post_id: { type: "integer" },
      publish_status: { type: "string", maxLength: 40 },
      last_error: { type: "string", maxLength: 1000 },
    },
    { readOnlyHint: false },
  ),
  tool(
    "enqueue_publish",
    "Enqueue a publish, update, or unpublish job for a listing on a site, for that site's own Worker to execute. Requires a write key.",
    {
      listing_id: { type: "string", maxLength: 100 },
      site_id: { type: "string", maxLength: 100 },
      action: { type: "string", maxLength: 40 },
      requested_by: { type: "string", maxLength: 200 },
    },
    { readOnlyHint: false, idempotentHint: false },
  ),
  tool(
    "dequeue_publish",
    "Remove a publish_queue job by id after it has been executed. Requires a write key.",
    { id: { type: "integer", minimum: 1 } },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  ),
  tool(
    "upsert_geodir_category",
    "Create or update a GeoDirectory places category on a specific site, by proxying to that site's own geodir/v2 REST API (name required; pass parent to create a subcategory; pass id to update an existing category instead of creating one). Requires a write key.",
    {
      site_id: { type: "string", maxLength: 100 },
      id: { type: "integer" },
      name: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 2000 },
      slug: { type: "string", maxLength: 200 },
      parent: { type: "integer" },
      fa_icon: { type: "string", maxLength: 100 },
      fa_icon_color: { type: "string", maxLength: 20 },
    },
    { readOnlyHint: false },
  ),
  tool(
    "upsert_geodir_tag",
    "Create or update a GeoDirectory places tag on a specific site, by proxying to that site's own geodir/v2 REST API. Requires a write key.",
    {
      site_id: { type: "string", maxLength: 100 },
      id: { type: "integer" },
      name: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 2000 },
      slug: { type: "string", maxLength: 200 },
    },
    { readOnlyHint: false },
  ),
  tool(
    "update_geodir_settings",
    "Update a single GeoDirectory setting (by group_id and setting id) on a specific site, by proxying to that site's own geodir/v2 REST API. Note: GeoDirectory custom fields have no write endpoint and cannot be managed through this tool -- those still require the site's own wp-admin. Requires a write key.",
    {
      site_id: { type: "string", maxLength: 100 },
      group_id: { type: "string", maxLength: 100 },
      id: { type: "string", maxLength: 100 },
      value: {},
    },
    { readOnlyHint: false, idempotentHint: false },
  ),
];

export const MCP_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((entry) => entry.name));

const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: value });
const error = (id: unknown, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) },
});

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateArguments(name: string, args: Record<string, unknown>): void {
  const definition = MCP_TOOLS.find((entry) => entry.name === name);
  const properties = (definition?.inputSchema.properties ?? {}) as Record<
    string,
    { type?: string; minimum?: number; maximum?: number; maxLength?: number }
  >;
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (!property) throw new Error(`Unsupported argument: ${key}`);
    if (property.type === "integer" && !Number.isInteger(value)) {
      throw new Error(`${key} must be an integer`);
    }
    if (property.type === "number" && typeof value !== "number") {
      throw new Error(`${key} must be a number`);
    }
    if (property.type === "string" && typeof value !== "string") {
      throw new Error(`${key} must be a string`);
    }
    if (typeof value === "number" &&
      ((property.minimum !== undefined && value < property.minimum) ||
       (property.maximum !== undefined && value > property.maximum))) {
      throw new Error(`${key} is outside the supported range`);
    }
    if (typeof value === "string" && property.maxLength !== undefined && value.length > property.maxLength) {
      throw new Error(`${key} is too long`);
    }
  }
}

async function dispatch(message: RpcRequest, request: Request, env: Env, writeAuthorized: boolean) {
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return error(message.id, -32600, "Invalid Request");
  }
  if (message.method.startsWith("notifications/")) return null;
  if (message.method === "initialize") {
    return result(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "directory-engine-api", version: "0.4.0" },
      instructions:
        "Inspect WordPress, GeoDirectory, and DIRECTORY_DB using read-only tools (pass site_id to target a specific site; omit it for the legacy default site), or write via upsert_site / upsert_integration_connection / upsert_master_listing / upsert_listing_site_link / enqueue_publish / dequeue_publish / upsert_geodir_category / upsert_geodir_tag / update_geodir_settings (requires X-Directory-Engine-Write-Key). Custom fields have no write endpoint on GeoDirectory's own REST API and still require wp-admin.",
    });
  }
  if (message.method === "ping") return result(message.id, {});
  if (message.method === "tools/list") return result(message.id, { tools: MCP_TOOLS });
  if (message.method !== "tools/call") return error(message.id, -32601, "Method not found");

  const params = record(message.params);
  const args = record(params?.arguments ?? {}) ?? {};
  const name = params?.name;
  if (typeof name !== "string" || !MCP_TOOLS.some((entry) => entry.name === name)) {
    return error(message.id, -32602, "Invalid params", "Unknown tool");
  }
  if (WRITE_TOOL_NAMES.has(name) && !writeAuthorized) {
    return result(message.id, {
      isError: true,
      content: [{ type: "text", text: "Write access requires a valid X-Directory-Engine-Write-Key header" }],
    });
  }
  try {
    validateArguments(name, args);
    const value = WRITE_TOOL_NAMES.has(name)
      ? await runWriteOperation(name, args, env, request)
      : await runReadOperation(name, args, env);
    return result(message.id, {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
    });
  } catch (cause) {
    return result(message.id, {
      isError: true,
      content: [{ type: "text", text: cause instanceof Error ? cause.message : "Operation failed" }],
    });
  }
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(request, env, { error: "Method not allowed" }, { status: 405, headers: { allow: "POST, OPTIONS" } });
  }
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return jsonResponse(request, env, { error: "Content-Type must be application/json" }, { status: 415 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(request, env, error(null, -32700, "Parse error"), { status: 400 });
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  if (!messages.length || messages.some((message) => !record(message))) {
    return jsonResponse(request, env, error(null, -32600, "Invalid Request"), { status: 400 });
  }
  const writeAuthorized = isWriteAuthorized(request, env);
  const responses = (
    await Promise.all(messages.map((message) => dispatch(message as RpcRequest, request, env, writeAuthorized)))
  ).filter((message) => message !== null);
  if (!responses.length) return new Response(null, { status: 202, headers: corsHeaders(request, env) });
  return jsonResponse(request, env, Array.isArray(payload) ? responses : responses[0]);
}
