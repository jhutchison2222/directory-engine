import {
  geoPath,
  getDatabaseSchema,
  getDatabaseStatus,
  listSites,
  resolveSiteConnection,
  ROUTES,
  safeError,
  testConnections,
  VERSION,
  wordpressCollectionPath,
  wordpressGet,
} from "./inspection";
import { handleMcp, MCP_TOOLS } from "./mcp";
import { filterQuery } from "./operations";
import { corsHeaders, isAuthorized, isWriteAuthorized, jsonResponse } from "./security";
import type { Env } from "./types";
import {
  dequeuePublish,
  enqueuePublish,
  listPublishQueue,
  parseJsonBody,
  safeWriteError,
  upsertIntegrationConnection,
  upsertListingSiteLink,
  upsertMasterListing,
  upsertSite,
  upsertSiteProfile,
  ValidationError,
} from "./write-operations";

function capabilities() {
  return {
    service: "directory-engine-api",
    version: VERSION,
    read_only: false,
    authentication: {
      read: ["Authorization: Bearer <DIRECTORY_ENGINE_API_KEY>", "X-Directory-Engine-Key: <DIRECTORY_ENGINE_API_KEY>"],
      write: ["X-Directory-Engine-Write-Key: <DIRECTORY_ENGINE_WRITE_API_KEY> (also requires a valid read key)"],
    },
    database_binding: "DIRECTORY_DB",
    routes: {
      health: "/health",
      capabilities: "/v1/capabilities",
      connection_test: "/v1/connection-test",
      database: ["/v1/database/status", "/v1/database/schema"],
      sites_read: "/v1/sites",
      wordpress: ROUTES.wordpress.map((name) => `/v1/wordpress/${name}`),
      geodirectory: ROUTES.geodirectory.map((name) => `/v1/geodirectory/${name}`),
      publish_queue_read: "/v1/publish-queue",
      write: {
        site_profiles: "POST /v1/write/site-profiles (deprecated -- use sites)",
        sites: "POST /v1/write/sites",
        integration_connections: "POST /v1/write/integration-connections",
        master_listings: "POST /v1/write/master-listings",
        listing_site_links: "POST /v1/write/listing-site-links",
        publish_queue_enqueue: "POST /v1/write/publish-queue",
        publish_queue_dequeue: "DELETE /v1/write/publish-queue/:id",
      },
      mcp: "/mcp",
    },
    mcp_tools: MCP_TOOLS.map(({ name }) => name),
    notes: [
      "Every WordPress/GeoDirectory read route and MCP tool now accepts an optional ?site_id= (routes) or site_id argument (MCP tools) to target a specific site.",
      "Omitting site_id falls back to the legacy WORDPRESS_BASE_URL/GEODIRECTORY_CONSUMER_KEY/SECRET env vars, unchanged from v0.2.0/v0.3.0.",
    ],
  };
}

async function readRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/v1/capabilities") return jsonResponse(request, env, capabilities());

  const siteId = url.searchParams.get("site_id") ?? undefined;

  if (url.pathname === "/v1/connection-test") {
    return jsonResponse(request, env, await testConnections(env, siteId));
  }
  if (url.pathname === "/v1/database/status") {
    return jsonResponse(request, env, await getDatabaseStatus(env));
  }
  if (url.pathname === "/v1/database/schema") {
    return jsonResponse(request, env, await getDatabaseSchema(env));
  }
  if (url.pathname === "/v1/sites") {
    return jsonResponse(
      request,
      env,
      await listSites(env, {
        status: url.searchParams.get("status") ?? undefined,
        site_role: url.searchParams.get("site_role") ?? undefined,
      }),
    );
  }
  if (url.pathname === "/v1/publish-queue") {
    return jsonResponse(
      request,
      env,
      await listPublishQueue(env, {
        site_id: url.searchParams.get("site_id") ?? undefined,
        listing_id: url.searchParams.get("listing_id") ?? undefined,
      }),
    );
  }

  const wordpress = url.pathname.match(/^\/v1\/wordpress\/(pages|posts|categories)(?:\/(\d+))?$/);
  if (wordpress) {
    const connection = await resolveSiteConnection(env, siteId);
    const path = wordpressCollectionPath(wordpress[1]) + (wordpress[2] ? `/${wordpress[2]}` : "");
    return jsonResponse(request, env, await wordpressGet(connection, path, filterQuery(url.searchParams)));
  }
  const geodirectory = url.pathname.match(
    /^\/v1\/geodirectory\/(listing-types|taxonomies|fields|settings|locations|cities)$/,
  );
  if (geodirectory) {
    const connection = await resolveSiteConnection(env, siteId);
    return jsonResponse(
      request,
      env,
      await wordpressGet(connection, geoPath(geodirectory[1]), filterQuery(url.searchParams)),
    );
  }
  return jsonResponse(request, env, { error: "Not found" }, { status: 404 });
}

function methodNotAllowed(request: Request, env: Env, allow: string): Response {
  return jsonResponse(request, env, { error: "Method not allowed" }, { status: 405, headers: { allow } });
}

async function writeRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/v1/write/site-profiles") {
    if (request.method !== "POST") return methodNotAllowed(request, env, "POST, OPTIONS");
    return jsonResponse(request, env, await upsertSiteProfile(env, request, await parseJsonBody(request)));
  }
  if (url.pathname === "/v1/write/sites") {
    if (request.method !== "POST") return methodNotAllowed(request, env, "POST, OPTIONS");
    return jsonResponse(request, env, await upsertSite(env, request, await parseJsonBody(request)));
  }
  if (url.pathname === "/v1/write/integration-connections") {
    if (request.method !== "POST") return methodNotAllowed(request, env, "POST, OPTIONS");
    return jsonResponse(request, env, await upsertIntegrationConnection(env, request, await parseJsonBody(request)));
  }
  if (url.pathname === "/v1/write/master-listings") {
    if (request.method !== "POST") return methodNotAllowed(request, env, "POST, OPTIONS");
    return jsonResponse(request, env, await upsertMasterListing(env, request, await parseJsonBody(request)));
  }
  if (url.pathname === "/v1/write/listing-site-links") {
    if (request.method !== "POST") return methodNotAllowed(request, env, "POST, OPTIONS");
    return jsonResponse(request, env, await upsertListingSiteLink(env, request, await parseJsonBody(request)));
  }
  if (url.pathname === "/v1/write/publish-queue") {
    if (request.method !== "POST") return methodNotAllowed(request, env, "POST, OPTIONS");
    return jsonResponse(request, env, await enqueuePublish(env, request, await parseJsonBody(request)), { status: 201 });
  }
  const dequeueMatch = url.pathname.match(/^\/v1\/write\/publish-queue\/(\d+)$/);
  if (dequeueMatch) {
    if (request.method !== "DELETE") return methodNotAllowed(request, env, "DELETE, OPTIONS");
    return jsonResponse(request, env, await dequeuePublish(env, request, Number(dequeueMatch[1])));
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

  if (url.pathname.startsWith("/v1/write/")) {
    if (!isWriteAuthorized(request, env)) {
      return jsonResponse(request, env, { error: "Write access requires X-Directory-Engine-Write-Key" }, { status: 403 });
    }
    try {
      return await writeRoute(request, env, url);
    } catch (cause) {
      console.error("write request failed", safeWriteError(cause));
      const status = cause instanceof ValidationError ? 400 : 500;
      return jsonResponse(request, env, { error: safeWriteError(cause) }, { status });
    }
  }

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

export default {
  fetch(request: Request, env: Env) {
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;
