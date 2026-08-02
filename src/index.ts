import {
  getDatabaseSchema,
  getDatabaseStatus,
  geoPath,
  ROUTES,
  safeError,
  testConnections,
  UpstreamError,
  VERSION,
  wordpressCollectionPath,
  wordpressGet,
} from "./inspection";
import { handleMcp, MCP_TOOLS } from "./mcp";
import { filterQuery } from "./operations";
import { corsHeaders, isAuthorized, jsonResponse } from "./security";
import type { Env } from "./types";

function capabilities() {
  return {
    service: "directory-engine",
    version: VERSION,
    read_only: true,
    authentication: ["Authorization: Bearer <API_KEY>", "X-API-Key: <API_KEY>"],
    database_binding: "DIRECTORY_DB",
    routes: {
      health: "/health",
      capabilities: "/v1/capabilities",
      connection_test: "/v1/connection-test",
      database: ["/v1/database/status", "/v1/database/schema"],
      wordpress: ROUTES.wordpress.map((name) => `/v1/wordpress/${name}`),
      geodirectory: ROUTES.geodirectory.map((name) => `/v1/geodirectory/${name}`),
      mcp: "/mcp",
    },
    mcp_tools: MCP_TOOLS.map(({ name }) => name),
  };
}

async function readRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/v1/capabilities") return jsonResponse(request, env, capabilities());
  if (url.pathname === "/v1/connection-test") {
    return jsonResponse(request, env, await testConnections(env));
  }
  if (url.pathname === "/v1/database/status") {
    return jsonResponse(request, env, await getDatabaseStatus(env));
  }
  if (url.pathname === "/v1/database/schema") {
    return jsonResponse(request, env, await getDatabaseSchema(env));
  }

  const wordpress = url.pathname.match(/^\/v1\/wordpress\/(pages|posts|categories)(?:\/(\d+))?$/);
  if (wordpress) {
    const path = wordpressCollectionPath(wordpress[1]) + (wordpress[2] ? `/${wordpress[2]}` : "");
    return jsonResponse(request, env, await wordpressGet(env, path, filterQuery(url.searchParams)));
  }
  const geodirectory = url.pathname.match(
    /^\/v1\/geodirectory\/(listing-types|taxonomies|fields|settings|locations|cities)$/,
  );
  if (geodirectory) {
    return jsonResponse(
      request,
      env,
      await wordpressGet(env, geoPath(geodirectory[1]), filterQuery(url.searchParams)),
    );
  }
  return jsonResponse(request, env, { error: "Not found" }, { status: 404 });
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse(request, env, { status: "ok", service: "directory-engine", version: VERSION });
  }
  if (!isAuthorized(request, env)) {
    return jsonResponse(request, env, { error: "Unauthorized" }, { status: 401 });
  }
  if (url.pathname === "/mcp") return handleMcp(request, env);
  if (request.method !== "GET") {
    return jsonResponse(request, env, { error: "Method not allowed" }, {
      status: 405,
      headers: { allow: "GET, OPTIONS" },
    });
  }
  try {
    return await readRoute(request, env, url);
  } catch (error) {
    console.error("read request failed", safeError(error));
    return jsonResponse(
      request,
      env,
      { error: error instanceof UpstreamError ? "Upstream request failed" : "Inspection request failed" },
      { status: error instanceof UpstreamError ? 502 : 500 },
    );
  }
}

export default {
  fetch(request: Request, env: Env) {
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;
