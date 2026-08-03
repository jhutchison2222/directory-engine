import {
  getDatabaseSchema,
  getDatabaseStatus,
  geoPath,
  ROUTES,
  safeError,
  testConnections,
  VERSION,
  wordpressCollectionPath,
  wordpressGet,
} from "./inspection";
import { handleMcp, MCP_TOOLS } from "./mcp";
import { handleAuthorization } from "./oauth";
import { filterQuery } from "./operations";
import { corsHeaders, isAuthorized, jsonResponse } from "./security";
import type { Env } from "./types";

export const MCP_RESOURCE = "https://directory-engine-api.jhutchison.workers.dev/mcp";
export const READ_SCOPE = "mcp:read";

function capabilities() {
  return {
    service: "directory-engine-api",
    version: VERSION,
    read_only: true,
    authentication: [
      "OAuth 2.1 with mcp:read for /mcp",
      "Authorization: Bearer <DIRECTORY_ENGINE_API_KEY> for /v1/*",
      "X-Directory-Engine-Key: <DIRECTORY_ENGINE_API_KEY> for /v1/*",
    ],
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
    return jsonResponse(request, env, { status: "ok", service: "directory-engine-api", version: VERSION });
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
      { error: "Inspection request failed" },
      { status: 500 },
    );
  }
}

type OAuthProps = { permissions?: string[]; role?: string };
type PropsContext = ExecutionContext & { props?: OAuthProps };

export const mcpApiHandler = {
  async fetch(request, env, context) {
    const props = (context as PropsContext).props;
    if (!props?.permissions?.includes(READ_SCOPE)) {
      return jsonResponse(request, env, { error: "Forbidden" }, { status: 403 });
    }
    return handleMcp(request, env);
  },
} satisfies Pick<Required<ExportedHandler<Env>>, "fetch">;

export const defaultHandler: ExportedHandler<Env> = {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorization(request, env);
    return route(request, env);
  },
};

export default defaultHandler;

