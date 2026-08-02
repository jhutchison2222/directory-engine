import { runReadOperation } from "./operations";
import { corsHeaders, jsonResponse } from "./security";
import type { Env } from "./types";

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

const tool = (name: string, description: string, properties: Record<string, unknown> = {}) => ({
  name,
  description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { type: "object", properties, additionalProperties: false },
});

export const MCP_TOOLS = [
  tool("health_check", "Return the Directory Engine service version and health."),
  tool("test_connections", "Test read access to D1, WordPress, and GeoDirectory."),
  tool("get_database_status", "Return D1 connectivity and table count."),
  tool("get_database_schema", "Inspect tables and columns in the existing D1 database."),
  tool("list_listing_types", "List GeoDirectory listing types.", { ...collectionProperties }),
  tool("list_taxonomies", "List GeoDirectory taxonomies.", { ...collectionProperties, post_type: { type: "string" } }),
  tool("list_fields", "List GeoDirectory custom fields.", { ...collectionProperties, post_type: { type: "string" } }),
  tool("get_geodirectory_settings", "Read GeoDirectory settings."),
  tool("list_locations", "List GeoDirectory locations.", {
    ...collectionProperties,
    country: { type: "string" }, region: { type: "string" }, city: { type: "string" },
  }),
  tool("list_cities", "List GeoDirectory cities.", {
    ...collectionProperties, country: { type: "string" }, region: { type: "string" },
  }),
  tool("list_wordpress_pages", "List WordPress pages.", { ...collectionProperties, slug: { type: "string" } }),
  tool("list_wordpress_posts", "List WordPress posts.", { ...collectionProperties, slug: { type: "string" } }),
  tool("list_wordpress_categories", "List WordPress categories.", { ...collectionProperties, parent: { type: "integer" } }),
];

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

async function dispatch(message: RpcRequest, env: Env) {
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return error(message.id, -32600, "Invalid Request");
  }
  if (message.method.startsWith("notifications/")) return null;
  if (message.method === "initialize") {
    return result(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "directory-engine", version: "0.2.0" },
      instructions: "Inspect WordPress, GeoDirectory, and DIRECTORY_DB using read-only tools.",
    });
  }
  if (message.method === "ping") return result(message.id, {});
  if (message.method === "tools/list") return result(message.id, { tools: MCP_TOOLS });
  if (message.method !== "tools/call") return error(message.id, -32601, "Method not found");

  const params = record(message.params);
  const args = record(params?.arguments ?? {}) ?? {};
  if (typeof params?.name !== "string" || !MCP_TOOLS.some((entry) => entry.name === params.name)) {
    return error(message.id, -32602, "Invalid params", "Unknown tool");
  }
  try {
    validateArguments(params.name, args);
    const value = await runReadOperation(params.name, args, env);
    return result(message.id, {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
    });
  } catch (cause) {
    return result(message.id, {
      isError: true,
      content: [{ type: "text", text: cause instanceof Error ? cause.message : "Read operation failed" }],
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
  const responses = (await Promise.all(messages.map((message) => dispatch(message as RpcRequest, env))))
    .filter((message) => message !== null);
  if (!responses.length) return new Response(null, { status: 202, headers: corsHeaders(request, env) });
  return jsonResponse(request, env, Array.isArray(payload) ? responses : responses[0]);
}
